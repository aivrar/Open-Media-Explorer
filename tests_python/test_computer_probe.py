from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from datetime import date
from pathlib import Path
from unittest import mock

import worldmedia_computer_probe as probe
from worldmedia_computer_library import _absolute_disk_path


# Representative ffprobe JSON, keeping the fields that affect the index.
SAMPLES = json.loads(r"""
{
  "mp3": {
    "format": {"filename": "C:\\Private\\03 - Song.mp3", "format_name": "mp3",
      "duration": "40.25", "bit_rate": "192000", "tags": {"TITLE": "Tagged Song",
        "ARTIST": "Performer", "album": "Record", "Album_Artist": "Various Artists",
        "track": "3/12", "disc": "2/3", "date": "released 1999-09-01",
        "genre": "Rock", "composer": "Writer"}},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "mp3",
      "sample_rate": "44100", "channels": 2, "bits_per_sample": 0}]
  },
  "flac": {
    "format": {"format_name": "flac", "tags": {"TRACKNUMBER": "4", "TRACKTOTAL": "10",
      "REPLAYGAIN_TRACK_GAIN": "-8.50 dB", "REPLAYGAIN_TRACK_PEAK": "0.972",
      "REPLAYGAIN_ALBUM_GAIN": "+1.25 DB", "REPLAYGAIN_ALBUM_PEAK": "1.0"}},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "flac",
      "sample_rate": "96000", "bits_per_raw_sample": "24", "channels": 2}]
  },
  "ogg": {
    "format": {"format_name": "ogg", "tags": {"title": " "}},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "opus",
      "sample_rate": "48000", "channels": 1, "tags": {"TiTle": "Stream Song", "ARTIST": "Singer"}}]
  },
  "m4b": {
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "tags": {"TITLE": "The Book"}},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "aac"}],
    "chapters": [{"start_time": "0.000", "tags": {"TITLE": "Introduction"}},
                 {"start_time": "600.750", "tags": {"title": "Chapter II"}}]
  },
  "mkv": {
    "format": {"format_name": "matroska,webm"},
    "streams": [
      {"index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
        "avg_frame_rate": "24000/1001", "r_frame_rate": "48/1", "pix_fmt": "yuv420p"},
      {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2,
        "tags": {"language": "jpn", "title": "Original"}, "disposition": {"default": 0}},
      {"index": 2, "codec_type": "audio", "codec_name": "flac", "channels": 6, "sample_rate": "48000",
        "tags": {"language": "eng", "title": "Surround"}, "disposition": {"default": 1}},
      {"index": 3, "codec_type": "subtitle", "codec_name": "ass",
        "tags": {"language": "eng", "title": "Signs"}, "disposition": {"default": 1}},
      {"index": 4, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "spa"}}
    ]
  },
  "mpegvideo": {
    "format": {"format_name": "mpegvideo"},
    "streams": [{"index": 0, "codec_type": "video", "codec_name": "mpeg2video"}]
  },
  "dsd": {
    "format": {"format_name": "dsf"},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "dsd_lsbf_planar",
      "sample_rate": "352800", "bits_per_sample": 8}]
  },
  "cover": {
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "alac"},
      {"index": 1, "codec_type": "video", "codec_name": "mjpeg", "width": 500,
        "disposition": {"attached_pic": 1}, "tags": {"title": "Cover Art"}}]
  }
}
""")


VIDEO_NAMES = [
    ("The.Movie.Name.2019.1080p.BluRay.x264-GRP.mkv", {"title": "The Movie Name", "year": 2019}),
    ("Show.Name.S02E05.720p.mkv", {"title": "Show Name", "season": 2, "episode": 5}),
    ("Show_Name_(2024)_s01e03_WEB-DL.MP4", {"title": "Show Name", "year": 2024, "season": 1, "episode": 3}),
    ("My holiday.v2_final.mp4", {"title": "My holiday.v2_final"}),
    ("My_holiday.v2_final.mp4", {"title": "My holiday v2 final"}),
    ("Plain.avi", {"title": "Plain"}),
    ("The Proper Way.mp4", {"title": "The Proper Way"}),
    ("The-Proper-Way.mp4", {"title": "The-Proper-Way"}),
    ("Limited Edition Concert.mkv", {"title": "Limited Edition Concert"}),
    ("A Dual Language Concert Remastered.mkv", {"title": "A Dual Language Concert Remastered"}),
    ("The Proper Way 1080p BluRay.mkv", {"title": "The Proper Way"}),
    ("Limited Edition Concert WEB-DL.mkv", {"title": "Limited Edition Concert"}),
    ("Film 2022 Proper.mkv", {"title": "Film", "year": 2022}),
    ("Film (2022) Extended Edition.mkv", {"title": "Film", "year": 2022}),
    ("The.Proper.Way.mp4", {"title": "The"}),
    ("Concert_Limited_Edition.mkv", {"title": "Concert"}),
    ("2001.mp4", {"title": "2001"}),
    ("東京の 映画.mp4", {"title": "東京の 映画"}),
    ("Blade.Runner.2049.2017.1080p.mkv", {"title": "Blade Runner 2049", "year": 2017}),
    ("1917.2019.2160p.mkv", {"title": "1917", "year": 2019}),
    ("Blade Runner 2049.mkv", {"title": "Blade Runner 2049"}),
    ("Film 2019.mkv", {"title": "Film 2019"}),
    ("2001 A Space Odyssey (1968).mkv", {"title": "2001 A Space Odyssey", "year": 1968}),
    ("Top.Gun.Maverick.2022.IMAX.WEB-DL.mkv", {"title": "Top Gun Maverick", "year": 2022}),
    ("Film_2027_Directors_Cut.mkv", {"title": "Film", "year": 2027}),
    ("Film.2028.UHD.mkv", {"title": "Film 2028"}),
    ("Film.1899.Remastered.mkv", {"title": "Film 1899"}),
    ("The.Matrix.1999.[1080p].mkv", {"title": "The Matrix", "year": 1999}),
]


class ComputerProbeTests(unittest.TestCase):
    def test_video_names(self):
        with mock.patch.object(probe, "date") as today:
            today.today.return_value = date(2026, 11, 26)
            for filename, expected in VIDEO_NAMES:
                with self.subTest(filename=filename):
                    self.assertEqual(probe.clean_video_title(filename), expected)

    def test_mp3_tags_and_audio_fallbacks(self):
        item = probe.probe_fields(SAMPLES["mp3"], "Sub/01 - Untagged.mp3", "Root")
        self.assertEqual(item, {
            "kind": "audio", "title": "Tagged Song", "artist": "Performer", "album": "Record",
            "album_artist": "Various Artists", "track": 3, "track_total": 12, "disc": 2,
            "year": 1999, "genre": "Rock", "composer": "Writer", "duration": 40.25,
            "bitrate": 192000, "container": "mp3", "acodec": "mp3", "sample_rate": 44100,
            "channels": 2, "lossless": False,
        })
        self.assertEqual(probe.name_fields("Sub/03 - Song.mp3", "audio", "Root"),
                         {"title": "Song", "track": 3, "album": "Sub"})
        self.assertEqual(probe.name_fields("Plain.mp3", "audio", "Root"),
                         {"title": "Plain", "album": "Root"})

    def test_audio_names(self):
        for filename, numbered, fields in [
            ("03 - Song.mp3", False, {"title": "Song", "track": 3}),
            ("03. Song.mp3", False, {"title": "Song", "track": 3}),
            ("03_Song.mp3", False, {"title": "Song", "track": 3}),
            ("2-05 Title.mp3", False, {"title": "Title", "disc": 2, "track": 5}),
            ("2.05 Title.mp3", False, {"title": "Title", "disc": 2, "track": 5}),
            ("03 Song.mp3", True, {"title": "Song", "track": 3}),
            ("99 Luftballons.mp3", False, {"title": "99 Luftballons"}),
        ]:
            with self.subTest(filename=filename):
                self.assertEqual(probe.name_fields(filename, "audio", "Root", numbered=numbered),
                                 {**fields, "album": "Root"})

    def test_tag_text_keeps_user_text_and_is_idempotent(self):
        for value, expected in [
            ("x" * 1022 + " / Live", "x" * 1022 + " /"),
            ("x" * 1022 + "  Live", "x" * 1022),
            (r"  AC/DC \ Music C:\Artist \\share\artist https://example.org/東京  ",
             r"AC/DC \ Music C:\Artist \\share\artist https://example.org/東京"),
            ("\t A\x00C\x1f/D\x7fC 🎵 \x01 ", "AC/DC 🎵"),
            ("\x00\x7f \t", None),
            (17, None),
            (None, None),
        ]:
            with self.subTest(value=value):
                self.assertEqual(probe.tag_text(value), expected)
                self.assertEqual(probe.tag_text(probe.tag_text(value)), expected)

    def test_year_uses_first_valid_year_in_tag_order(self):
        for tags, year in [
            ({"date": "0099, 1999 and 2000", "year": "2019"}, 1999),
            ({"date": "undated", "year": "2019", "originaldate": "2017"}, 2019),
            ({"date": "3000", "year": "unknown", "originaldate": "2017", "originalyear": "1990"}, 2017),
            ({"date": "120190", "originalyear": "1990"}, 1990),
        ]:
            with self.subTest(tags=tags):
                self.assertEqual(probe.probe_fields({"format": {"tags": tags}}, "Song.mp3", "Root")["year"],
                                 year)

    def test_duration_and_bitrate_prefer_format_then_video_then_audio(self):
        for format_fields, video_fields, expected in [
            ({"duration": "40.25", "bit_rate": "192000"}, {"duration": "22", "bit_rate": "64000"}, (40.25, 192000)),
            ({}, {"duration": "22", "bit_rate": "64000"}, (22.0, 64000)),
            ({"duration": "NaN", "bit_rate": "0"}, {}, (12.0, 32000)),
        ]:
            with self.subTest(format_fields=format_fields, video_fields=video_fields):
                item = probe.probe_fields({
                    "format": format_fields,
                    "streams": [{"codec_type": "video", **video_fields},
                                {"codec_type": "audio", "duration": "12", "bit_rate": "32000"}],
                }, "Movie.mkv", "Root")
                self.assertEqual((item["duration"], item["bitrate"]), expected)

    def test_track_and_disc_aliases_follow_source_precedence(self):
        for format_tags, stream_tags in [
            ({"tracknumber": "3/8", "disc": "2"}, {"track": "1/9", "discnumber": "1"}),
            ({"track": "3/8", "discnumber": "2"}, {"tracknumber": "1/9", "disc": "1"}),
            ({"track": "3/8", "tracknumber": "1/9", "disc": "2", "discnumber": "1"}, {}),
            ({}, {"tracknumber": "3/8", "discnumber": "2"}),
        ]:
            with self.subTest(format_tags=format_tags, stream_tags=stream_tags):
                item = probe.probe_fields({"format": {"tags": format_tags},
                                           "streams": [{"codec_type": "audio", "tags": stream_tags}]},
                                          "Song.mp3", "Root")
                self.assertEqual((item["track"], item["track_total"], item["disc"]), (3, 8, 2))

    def test_dsd_uses_unpacked_rate_and_bit_depth_and_dst_is_lossless(self):
        item = probe.probe_fields(SAMPLES["dsd"], "Song.dsf", "Root")
        self.assertEqual((item["sample_rate"], item["bits"], item["lossless"]), (2822400, 1, True))
        dst = probe.probe_fields({"streams": [{"codec_type": "audio", "codec_name": "dst",
                                               "sample_rate": "352800"}]}, "Song.dff", "Root")
        self.assertEqual((dst["sample_rate"], dst["bits"], dst["lossless"]), (2822400, 1, True))

    def test_mpegvideo_fixture_is_whitelisted(self):
        with mock.patch.object(probe.subprocess, "Popen", side_effect=FileNotFoundError) as popen:
            with self.assertRaisesRegex(probe.RetryableProbeError, "could not run"):
                probe.run_ffprobe("ffprobe", "Movie.mpg", threading.Event())
        command = popen.call_args.args[0]
        self.assertIn("mpegvideo", command[command.index("-format_whitelist") + 1].split(","))
        item = probe.probe_fields(SAMPLES["mpegvideo"], "Movie.mpg", "Root")
        self.assertEqual((item["kind"], item["container"], item["vcodec"]), ("video", "mpegvideo", "mpeg2video"))

    def test_flac_replaygain_and_ogg_stream_tags(self):
        flac = probe.probe_fields(SAMPLES["flac"], "Song.flac", "Record")
        self.assertEqual(flac, {
            "kind": "audio", "title": "Song", "album": "Record", "track": 4, "track_total": 10,
            "container": "flac", "acodec": "flac", "bits": 24, "sample_rate": 96000, "channels": 2,
            "lossless": True, "rg_track_gain": -8.5, "rg_track_peak": 0.972,
            "rg_album_gain": 1.25, "rg_album_peak": 1.0,
        })
        ogg = probe.probe_fields(SAMPLES["ogg"], "Song.ogg", "Record")
        self.assertEqual((ogg["artist"], ogg["title"], ogg["acodec"]), ("Singer", "Stream Song", "opus"))

    def test_chapters_are_capped(self):
        item = probe.probe_fields(SAMPLES["m4b"], "Book.m4b", "Books")
        self.assertEqual(item["title"], "The Book")
        self.assertEqual(item["chapters"], [{"start": 0.0, "title": "Introduction"},
                                           {"start": 600.75, "title": "Chapter II"}])
        large = {**SAMPLES["m4b"], "chapters": SAMPLES["m4b"]["chapters"] * 300}
        self.assertEqual(len(probe.probe_fields(large, "Book.m4b", "Books")["chapters"]), 500)

    def test_tracks_default_video_kind_and_real_title(self):
        sample = SAMPLES["mkv"]
        item = probe.probe_fields(sample, "Show.Name.S02E05.720p.mka", "Shows")
        self.assertEqual((item["title"], item["kind"], item["season"], item["episode"]), ("Show Name", "video", 2, 5))
        self.assertEqual((item["acodec"], item["sample_rate"], item["channels"]), ("flac", 48000, 6))
        self.assertEqual((item["vcodec"], item["width"], item["height"], item["pix_fmt"]),
                         ("h264", 1920, 1080, "yuv420p"))
        self.assertAlmostEqual(item["fps"], 24000 / 1001)
        self.assertEqual(item["audio_tracks"], [
            {"index": 1, "codec": "aac", "language": "jpn", "title": "Original", "default": False},
            {"index": 2, "codec": "flac", "language": "eng", "title": "Surround", "default": True},
        ])
        self.assertEqual(item["subtitle_tracks"], [
            {"index": 3, "codec": "ass", "language": "eng", "title": "Signs", "default": True},
            {"index": 4, "codec": "subrip", "language": "spa", "default": False},
        ])
        tagged = {**sample, "format": {"tags": {"TITLE": "An Actual Title", "artist": r"C:\Private\Artist"}}}
        item = probe.probe_fields(tagged, "Show.Name.S02E05.720p.mka", "Shows")
        self.assertEqual(item["title"], "An Actual Title")
        self.assertEqual(item["season"], 2)
        self.assertEqual(item["artist"], r"C:\Private\Artist")

    def test_episode_titles_remove_movie_release_markers(self):
        cases = [
            ("Test.Show.S01E01.720p.mkv", None, ""),
            ("Test Show S01E01 WEB-DL h265 [Group].mkv", "Test Show", ""),
            ("Test.Show.S01E02E03.Pilot.(2021).1080p-WEBRip-Team.mkv", "E03 Pilot", "Pilot"),
            ("Test.Show.S01E03.Second_Act.[Group].mkv", "1080p", "Second Act"),
            ("Test.Show.S01E04.Pilot.REPACK.mkv", "Actual title", "Actual title"),
        ]
        for name, title, expected in cases:
            with self.subTest(name=name, title=title):
                data = {**SAMPLES["mkv"], "format": {"tags": {"title": title}}}
                fields = probe.probe_fields(data, name, "Shows")
                self.assertEqual(fields["episode_title"], expected)
                self.assertEqual(fields["season"], 1)

    def test_container_and_placeholder_audio_stream_are_not_audio(self):
        streams = [
            [],
            [{"codec_type": "audio"}],
            [{"codec_type": "audio", "codec_name": "flac", "sample_rate": "0", "channels": 0}],
        ]
        for values in streams:
            with self.subTest(streams=values):
                fields = probe.probe_fields({
                    "format": {"format_name": "flac", "probe_score": 1}, "streams": values,
                }, "fake.flac", "Music")
                self.assertEqual(fields["error"], probe.UNREADABLE_AUDIO)
                self.assertNotIn("acodec", fields)
        fields = probe.probe_fields({
            "format": {"format_name": "flac", "probe_score": 1},
            "streams": [
                {"codec_type": "audio", "disposition": {"default": 1}},
                {"codec_type": "audio", "codec_name": "flac", "sample_rate": "8000", "channels": 1},
            ],
        }, "real.flac", "Music")
        self.assertEqual(fields["acodec"], "flac")
        self.assertNotIn("error", fields)
        self.assertNotIn("duration", fields)

    def test_embedded_cover_is_not_video(self):
        item = probe.probe_fields(SAMPLES["cover"], "01 - Melody.mp4", "Record")
        self.assertEqual(item["kind"], "audio")
        self.assertEqual(item["title"], "Melody")
        self.assertEqual(item["track"], 1)
        self.assertTrue(item["has_cover"])
        self.assertTrue(item["lossless"])
        for key in ("width", "vcodec", "audio_tracks", "subtitle_tracks"):
            self.assertNotIn(key, item)

    def test_runner_kills_a_child_on_limit_deadline_and_cancel(self):
        popen = subprocess.Popen
        for mode, code, timeout, limit, error in [
            ("oversize", "import sys,time; sys.stdout.buffer.write(b'x'*100000); time.sleep(10)",
             2, 1024, "too large"),
            ("deadline", "import time; time.sleep(10)", 0.15, 4096, "timed out"),
            ("cancel", "import time; time.sleep(10)", 2, 4096, None),
        ]:
            with self.subTest(mode=mode):
                cancel = threading.Event()
                processes = []

                def child(command, **kwargs):
                    self.assertEqual(command[0], "test-ffprobe")
                    self.assertEqual(command[-2:], ["-i", "media.mp3"])
                    self.assertFalse(kwargs["shell"])
                    if sys.platform == "win32":
                        self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW
                                         | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
                    process = popen([sys.executable, "-c", code], **kwargs)
                    processes.append(process)
                    if mode == "cancel":
                        cancel.set()
                    return process

                with mock.patch.object(probe.subprocess, "Popen", side_effect=child), \
                        mock.patch.object(probe, "PROBE_TIMEOUT", timeout), \
                        mock.patch.object(probe, "PROBE_OUTPUT_LIMIT", limit):
                    if error:
                        error_type = probe.RetryableProbeError if mode == "deadline" else probe.ProbeError
                        with self.assertRaisesRegex(error_type, error) as result:
                            probe.run_ffprobe("test-ffprobe", "media.mp3", cancel)
                        self.assertIs(type(result.exception), error_type)
                    else:
                        self.assertIsNone(probe.run_ffprobe("test-ffprobe", "media.mp3", cancel))
                self.assertIsNotNone(processes[0].poll())
                self.assertTrue(processes[0].stdout.closed)

    @unittest.skipUnless(shutil.which("ffprobe"), "ffprobe is not on PATH")
    def test_real_ffprobe_on_tiny_wav(self):
        with tempfile.TemporaryDirectory() as temporary:
            wav = Path(temporary) / "01 - Ä音.wav"
            with wave.open(str(wav), "wb") as handle:
                handle.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                handle.writeframes(b"\x00\x00" * 800)
            result = probe.run_ffprobe(shutil.which("ffprobe"), _absolute_disk_path(str(wav)), threading.Event())
            item = probe.probe_fields(result, wav.name, "Record")
            self.assertEqual(item["acodec"], "pcm_s16le")
            self.assertEqual((item["channels"], item["sample_rate"], item["bits"]), (1, 8000, 16))
            self.assertAlmostEqual(item["duration"], 0.1)
            self.assertTrue(item["lossless"])


if __name__ == "__main__":
    unittest.main()
