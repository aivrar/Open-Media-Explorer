from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from struct import pack
from unittest import mock

from worldmedia_computer_library import AUDIO_EXTENSIONS
from worldmedia_computer_probe import absolute_disk_path, numbered_audio_names, probe_fields, run_ffprobe
from worldmedia_computer_tags import TAG_EXTENSIONS, TinyTag, read_tags


FFPROBE = shutil.which("ffprobe")
FFMPEG = shutil.which("ffmpeg")
# Optional: a folder of real media to compare against ffprobe (set WORLDMEDIA_TEST_MEDIA).
_MEDIA = os.environ.get("WORLDMEDIA_TEST_MEDIA", "")
GENERATED = Path(absolute_disk_path(_MEDIA)) if _MEDIA and os.name == "nt" else None
# STREAMINFO and a single frame for 144 samples of 8 kHz, 16-bit mono silence.
STREAMINFO = bytes.fromhex("0240024000000c00000c01f400f0000000904556165d7fe41c7700cbe455a5767d40")
FLAC_FRAME = bytes.fromhex("fff86408008f4700000086b9")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHesAAAAASUVORK5CYII="
)
MP3_HEADER = bytes.fromhex("fffb9000")
MP3_FRAME = MP3_HEADER + bytes(413)


def flac(*comments):
    raw = [comment.encode("utf-8") for comment in comments]
    block = pack("<II", 0, len(raw)) + b"".join(pack("<I", len(value)) + value for value in raw)
    return b"fLaC\x00\x00\x00\x22" + STREAMINFO + b"\x84" + len(block).to_bytes(3, "big") + block + FLAC_FRAME


def opus(*comments):
    raw = [comment.encode("utf-8") for comment in comments]
    tags = b"OpusTags" + pack("<II", 0, len(raw)) + b"".join(pack("<I", len(value)) + value for value in raw)
    head = b"OpusHead" + pack("<BBHIhB", 1, 1, 312, 44100, 512, 0)

    def page(flags, granule, number, packet):
        return b"OggS\0" + pack("<BqIIIBB", flags, granule, 1, number, 0, 1, len(packet)) + packet

    return page(2, 0, 0, head) + page(0, 0, 1, tags) + page(4, 48312, 2, b"\xf8\xff\xfe")


def synchsafe(size):
    return bytes((size >> shift) & 127 for shift in (21, 14, 7, 0))


def id3(*frames):
    data = b"".join(key + synchsafe(len(content)) + b"\0\0" + content for key, content in frames)
    return b"ID3\x04\0\0" + synchsafe(len(data)) + data


class FastAudioTagsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(TinyTag, "Install requirements-build.txt")
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def file(self, name, contents):
        path = self.root / name
        disk_path = Path(absolute_disk_path(str(path)))
        disk_path.parent.mkdir(parents=True, exist_ok=True)
        disk_path.write_bytes(contents)
        return path

    def assert_matches_ffprobe(self, path, fields, rel=None, root_name=None, *, numbered=False):
        if FFPROBE is None:
            self.skipTest("ffprobe is not installed")
        data = run_ffprobe(FFPROBE, absolute_disk_path(str(path)), threading.Event())
        expected = probe_fields(data, rel or path.name, root_name or path.parent.name, numbered=numbered)
        self.assertEqual(set(fields), set(expected))
        for key, value in fields.items():
            self.assertIs(type(value), type(expected[key]), key)
            if key == "duration":
                self.assertAlmostEqual(value, expected[key], delta=0.1, msg=key)
            elif key == "bitrate":
                self.assertAlmostEqual(value, expected[key], delta=expected[key] * 0.02, msg=key)
            else:
                self.assertEqual(value, expected[key], key)

    def test_vorbis_tags_override_leading_id3_and_keep_repeated_values(self):
        prefix = id3((b"TALB", b"\x03Remaster"), (b"TCON", b"\x03New Wave"), (b"TPE1", b"\x03ID3 only"))
        path = self.file("Unlabelled.flac", prefix + flac(
            "TITLE=\tFirst\x1f ", "ALBUM=Original", "ALBUM ARTIST=Band", "GENRE=Rock/Synth-pop",
            "genre=Ballad", "GENRE=Rock/Synth-pop", "TRACKNUMBER=3/12", "DISCNUMBER=1/2",
            "YEAR=1980", "DATE=Recorded 1981", "REPLAYGAIN_TRACK_GAIN=-6.50 dB",
            "REPLAYGAIN_ALBUM_PEAK=0.991", "COMPILATION=1",
        ))
        fields = read_tags(path, "flac")
        self.assertEqual(fields["title"], "First")
        self.assertEqual(fields["album"], "Original")
        self.assertEqual(fields["album_artist"], "Band")
        self.assertEqual(fields["genre"], "Rock/Synth-pop;Ballad;Rock/Synth-pop")
        self.assertEqual((fields["track"], fields["track_total"], fields["disc"], fields["year"]), (3, 12, 1, 1981))
        self.assertEqual((fields["rg_track_gain"], fields["rg_album_peak"]), (-6.5, 0.991))
        self.assertNotIn("artist", fields)
        self.assert_matches_ffprobe(path, fields)

    def test_replaygain_uses_first_valid_comment_and_separate_peak_limits(self):
        fields = read_tags(self.file("Song.flac", flac(
            "REPLAYGAIN_TRACK_GAIN=52 dB", "REPLAYGAIN_TRACK_GAIN=-6.25dB", "REPLAYGAIN_TRACK_GAIN=-4",
            "REPLAYGAIN_ALBUM_GAIN=-51 DB", "REPLAYGAIN_TRACK_PEAK=0.8 dB", "REPLAYGAIN_ALBUM_PEAK=16",
        )), "flac")
        self.assertEqual({key: val for key, val in fields.items() if key.startswith("rg_")},
                         {"rg_track_gain": -6.25, "rg_album_gain": -51, "rg_album_peak": 16})
        for invalid in ("0", "-1", "16.001", "nan", "inf", "0.2;other", "0.8 dB"):
            with self.subTest(peak=invalid):
                fields = read_tags(self.file("Song.flac", flac(f"REPLAYGAIN_TRACK_PEAK={invalid}")), "flac")
                self.assertNotIn("rg_track_peak", fields)

    def test_opus_r128_precedence_reference_and_pre_skip(self):
        path = self.file("Song.opus", opus(
            "REPLAYGAIN_TRACK_GAIN=-9", "R128_TRACK_GAIN=broken", "R128_TRACK_GAIN=-256",
            "REPLAYGAIN_ALBUM_GAIN=-8", "R128_ALBUM_GAIN=128", "REPLAYGAIN_TRACK_PEAK=0.8",
        ))
        fields = read_tags(path, "opus")
        self.assertEqual((fields["rg_track_gain"], fields["rg_album_gain"], fields["rg_track_peak"]), (4, 5.5, 0.8))
        self.assertEqual(fields["duration"], 1)
        self.assertEqual(fields["sample_rate"], 48000)

    def test_vorbis_album_artist_spellings_and_genre_nul(self):
        for key in ("ALBUM ARTIST", "album artist", "albumartist", "album_artist"):
            with self.subTest(key=key):
                path = self.file("Song.flac", flac(f"{key}=Band", "GENRE=Rock\0Pop"))
                fields = read_tags(path, ".FLAC")
                self.assertEqual(fields["album_artist"], "Band")
                self.assertEqual(fields["genre"], "Rock")
                self.assert_matches_ffprobe(path, fields)

    def test_leading_id3_is_used_when_flac_has_no_vorbis_tags(self):
        prefix = id3((b"TIT2", b"\x03ID3 title"))
        path = self.file("Song.flac", prefix + flac())
        fields = read_tags(path, "flac")
        self.assertEqual(fields["title"], "ID3 title")
        self.assert_matches_ffprobe(path, fields)

    def test_mp3_duration_from_headers_or_spread_frames(self):
        frames = 40
        audio = MP3_FRAME * frames
        vbr_frame = bytes.fromhex("fffba000") + bytes(518)
        vbr = MP3_FRAME * 12 + vbr_frame * 24 + MP3_FRAME * 4
        clocked_duration = frames * 1152 / 44100
        cbr_duration = len(audio) * 8 / 128000
        large_picture = id3((b"APIC", b"\0image/png\0\x03\0" + PNG + bytes(9 * 1024**2)))
        footer = b"APETAGEX" + pack("<IIII", 2000, 32, 0, 0) + bytes(8)
        id3v1 = b"TAG" + b"Title".ljust(30) + bytes(95)
        tag = id3((b"TIT2", b"\x03A title"))

        def marker(name):
            # The intentionally inaccurate encoded byte count must not reject the header.
            return (MP3_HEADER + bytes(32) + name + pack(">III", 3, frames, 1)).ljust(len(MP3_FRAME), b"\0")

        vbri = (MP3_HEADER + bytes(32) + b"VBRI" + pack(">HHHII", 1, 0, 0, 1, frames))
        vbri = vbri.ljust(len(MP3_FRAME), b"\0")
        for label, data, duration in (
            ("Info CBR", marker(b"Info") + audio, clocked_duration),
            ("Xing VBR", marker(b"Xing") + vbr, clocked_duration),
            ("VBRI VBR", vbri + vbr, clocked_duration),
            ("Headerless CBR", audio, cbr_duration),
            ("Headerless VBR", vbr, None),
            ("Large ID3 picture", large_picture + audio, cbr_duration),
            ("Junk before first frame", tag + b"junk" * 800 + audio, cbr_duration),
            ("ID3v1 and APE tails", audio + footer + id3v1, cbr_duration),
        ):
            with self.subTest(label=label):
                fields = read_tags(self.file(label + ".mp3", data), "mp3")
                if duration is None:
                    self.assertIsNone(fields)
                else:
                    self.assertAlmostEqual(fields["duration"], duration, places=6)
                    self.assertEqual((fields["sample_rate"], fields["channels"]), (44100, 2))
        self.assertIsNone(read_tags(self.file("Truncated.mp3", MP3_FRAME), "mp3"))

    def test_reads_valid_flac_with_unknown_sample_count(self):
        streaminfo = bytearray(STREAMINFO)
        streaminfo[13] &= 0xf0
        streaminfo[14:18] = bytes(4)
        path = self.file("Unknown.flac", b"fLaC" + bytes.fromhex("80000022") + streaminfo + FLAC_FRAME)
        fields = read_tags(path, "flac")
        self.assertIsNotNone(fields)
        self.assertEqual((fields["sample_rate"], fields["acodec"]), (8000, "flac"))
        self.assertNotIn("duration", fields)
        self.assertNotIn("error", fields)

    def test_read_counts_for_common_audio_files(self):
        audio = MP3_FRAME * 1000
        info = (MP3_HEADER + bytes(32) + b"Info" + pack(">II", 1, 1000)).ljust(len(MP3_FRAME), b"\0")
        wav = self.root / "Song.wav"
        with wave.open(str(wav), "wb") as output:
            output.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            output.writeframes(bytes(1600))

        class CountingFile:
            def __init__(self, path, mode):
                self.handle = open(path, mode)
                self.reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.handle.close()

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def read(self, size):
                self.reads += 1
                return self.handle.read(size)

        cases = (
            (self.file("Song.flac", flac()), 15),
            (self.file("Info.mp3", info + audio), 2),
            (self.file("Headerless.mp3", audio), 4),
            (self.file("Short.mp3", MP3_FRAME * 5), 1),
            (wav, 14),
        )
        for path, reads in cases:
            with self.subTest(file=path.name):
                with CountingFile(path, "rb") as handle, mock.patch("worldmedia_computer_tags.open", return_value=handle):
                    self.assertIsNotNone(read_tags(path, path.suffix))
                    self.assertEqual(handle.reads, reads)

    def test_mp3_id3_cover_and_first_genre_value(self):
        prefix = id3((b"TPE2", b"\x03Band"), (b"TCON", b"\x03Rock\0Pop"), (b"TCON", b"\x03Folk"),
                     (b"TXXX", b"\x03replaygain_track_gain\0-6.0 dB"),
                     (b"TXXX", b"\x03replaygain_track_peak\0.85"),
                     (b"APIC", b"\0image/png\0\x03\0" + PNG))
        path = self.file("Song.mp3", prefix + MP3_FRAME * 16)
        fields = read_tags(path, "mp3")
        self.assertEqual((fields["album_artist"], fields["genre"]), ("Band", "Rock"))
        self.assertEqual((fields["rg_track_gain"], fields["rg_track_peak"]), (-6, .85))
        self.assertEqual((fields["has_cover"], fields["cover_stream"]), (True, 1))
        self.assert_matches_ffprobe(path, fields)

    def test_mp3_id3v1_does_not_hide_txxx_or_add_sound_check(self):
        prefix = id3((b"TXXX", b"\x03REPLAYGAIN_TRACK_GAIN\0+2.5 dB"),
                     (b"TXXX", b"\x03REPLAYGAIN_TRACK_PEAK\0.75dB"),
                     (b"TXXX", b"\x03iTunNORM\0 00000000 00000000"))
        id3v1 = b"TAG" + b"Title".ljust(30) + bytes(95)
        fields = read_tags(self.file("Song.mp3", prefix + MP3_FRAME * 16 + id3v1), "mp3")
        self.assertEqual({key: val for key, val in fields.items() if key.startswith("rg_")},
                         {"rg_track_gain": 2.5})

    def test_mp3_does_not_use_rva2_or_ape_replaygain(self):
        rva2 = (b"RVA2", b"track\0" + pack(">BhB", 1, -1536, 0))
        value = b"-3.25 dB"
        item = pack("<II", len(value), 0) + b"REPLAYGAIN_TRACK_GAIN\0" + value
        footer = b"APETAGEX" + pack("<IIII", 2000, 32 + len(item), 1, 0) + bytes(8)
        path = self.file("Song.mp3", id3(rva2) + MP3_FRAME * 16 + item + footer)
        fields = read_tags(path, "mp3")
        self.assertNotIn("rg_track_gain", fields)
        self.assert_matches_ffprobe(path, fields)

    @unittest.skipUnless(FFMPEG, "FFmpeg is required to make an M4A")
    def test_mp4_freeform_replaygain_ignores_sound_check(self):
        path = self.root / "Song.m4a"
        subprocess.run([
            FFMPEG, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
            "-t", "0.2", "-threads", "1", "-c:a", "aac", str(path),
        ], check=True, capture_output=True, timeout=10)

        def atom(key, body):
            return pack(">I4s", 8 + len(body), key) + body

        def freeform(name, value):
            return atom(b"----", atom(b"mean", bytes(4) + b"com.apple.iTunes")
                        + atom(b"name", bytes(4) + name) + atom(b"data", pack(">II", 1, 0) + value))

        source = path.read_bytes()
        moov = source.index(b"moov") - 4
        size = int.from_bytes(source[moov:moov + 4], "big")
        self.assertEqual(moov + size, len(source))
        extra = atom(b"udta", atom(b"meta", bytes(4) + atom(
            b"ilst", freeform(b"REPLAYGAIN_TRACK_GAIN", b"-2.75 dB")
            + freeform(b"replaygain_track_peak", b"0.64") + freeform(b"iTunNORM", b" 00000000 00000000"),
        )))
        path.write_bytes(source[:moov] + pack(">I", size + len(extra)) + source[moov + 4:] + extra)
        fields = read_tags(path, "m4a")
        self.assertEqual({key: val for key, val in fields.items() if key.startswith("rg_")},
                         {"rg_track_gain": -2.75, "rg_track_peak": 0.64})

    @unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg tools are required to make and probe an M4A cover")
    def test_mp4_cover_and_aac_codec(self):
        cover = self.file("Cover.png", PNG)
        path = self.root / "Song.m4a"
        subprocess.run([
            FFMPEG, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
            "-i", str(cover), "-t", "0.3", "-c:a", "aac", "-c:v", "copy", "-disposition:v", "attached_pic",
            "-metadata", "album_artist=Band", "-metadata", "composer=Writer", "-metadata", "disc=1/2", str(path),
        ], check=True, capture_output=True, timeout=10)
        fields = read_tags(path, "m4a")
        self.assertEqual((fields["acodec"], fields["album_artist"], fields["composer"], fields["disc"]),
                         ("aac", "Band", "Writer", 1))
        self.assertEqual((fields["has_cover"], fields["cover_stream"]), (True, 1))
        self.assert_matches_ffprobe(path, fields)

    def test_truncated_fake_and_empty_files_fall_back(self):
        fake_audio = [(f"fake.{ext}", b"This is plain text, not a media file.") for ext in ("flac", "mp3", "wav", "m4a")]
        for name, contents in (("Truncated.flac", flac("TITLE=Test")[:-6]), *fake_audio,
                               ("Empty.mp3", b""), ("Audio.m4b", b"anything"), ("Video.mp4", b"anything")):
            with self.subTest(name=name):
                self.assertIsNone(read_tags(self.file(name, contents), Path(name).suffix))

    def test_filename_fallback_and_long_unicode_path(self):
        path = self.root / ("Music-" + "a" * 70) / ("b" * 70) / ("c" * 70) / "01 - Élan.wav"
        self.assertGreater(len(str(path)), 260)
        target = Path(absolute_disk_path(str(path)))
        target.parent.mkdir(parents=True)
        with wave.open(str(target), "wb") as handle:
            handle.setparams((1, 2, 8000, 0, "NONE", ""))
            handle.writeframes(bytes(3200))
        fields = read_tags(path, "wav")
        self.assertEqual((fields["title"], fields["track"], fields["album"]), ("Élan", 1, path.parent.name))
        self.assert_matches_ffprobe(path, fields)

    def test_untagged_aiff_uses_filename(self):
        common = pack(">hIh", 1, 144, 16) + bytes.fromhex("400bfa00000000000000")
        sound = bytes(8 + 144 * 2)
        chunks = b"COMM" + pack(">I", len(common)) + common + b"SSND" + pack(">I", len(sound)) + sound
        path = self.file("3-02 Paper Planes.aif", b"FORM" + pack(">I", len(chunks) + 4) + b"AIFF" + chunks)
        fields = read_tags(path, "aif")
        self.assertEqual((fields["title"], fields["disc"], fields["track"]), ("Paper Planes", 3, 2))
        self.assert_matches_ffprobe(path, fields)

    def test_generated_library_matches_ffprobe(self):
        if FFPROBE is None or GENERATED is None or not GENERATED.is_dir():
            self.skipTest("generated library and ffprobe are required")
        folders = {}
        for path in GENERATED.rglob("*"):
            if path.is_file() and path.suffix.lower()[1:] in AUDIO_EXTENSIONS:
                folders.setdefault(path.parent, []).append(path)
        counts = dict.fromkeys(TAG_EXTENSIONS, 0)
        for files in folders.values():
            numbered = numbered_audio_names([path.name for path in files])
            for path in files:
                rel = path.relative_to(GENERATED).as_posix()
                ext = path.suffix.lower()[1:]
                with self.subTest(path=rel):
                    fields = read_tags(path, ext, rel=rel, root_name=GENERATED.name, numbered=numbered)
                    if fields is not None:
                        counts[ext] += 1
                        self.assert_matches_ffprobe(path, fields, rel, GENERATED.name, numbered=numbered)
                    elif ext in TAG_EXTENSIONS:
                        self.assertIn(path.name, {"broken.mp3", "fake.flac"})
        self.assertGreaterEqual(sum(counts.values()), 49)
        for ext in TAG_EXTENSIONS - {"aif"}:
            self.assertGreater(counts[ext], 0, ext)
