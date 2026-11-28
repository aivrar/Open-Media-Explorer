from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from array import array
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.parse import urlencode

import worldmedia_computer_subtitles as subtitles
import worldmedia_server as server
from tests_python import test_computer_media as media_tests
from tests_python.test_computer_video import FFMPEG, FFPROBE, ff, probe
from worldmedia_computer import ComputerFolders
from worldmedia_computer_media import ComputerMedia, _RequestCancel, _audio_choices
from worldmedia_computer_probe import run_ffprobe
from worldmedia_computer_video import ComputerVideo


_SRT = "1\n00:00:02,000 --> 00:00:03,000\nA cue\n\n"


class SubtitleMetadataTests(unittest.TestCase):
    def test_legacy_subtitle_code_pages(self):
        for language, page, line in (
            ("ru", "cp1251", "Привет, как дела?"), ("pl", "cp1250", "Zażółć gęślą jaźń."),
            ("de", "cp1252", "Grüße aus Köln"), ("fr", "cp1252", "Où fête-t-on l’été à Montréal ?"),
        ):
            for hint in ("", language):
                with self.subTest(language=language, hint=hint):
                    self.assertEqual(subtitles._decode_sidecar(line.encode(page), hint), line)
        for language, page, line in (("el", "cp1253", "Γεια σου"), ("uk", "cp1251", "ї"),
                                     ("tr", "cp1254", "ışık"), ("he", "cp1255", "שלום"),
                                     ("fa", "cp1256", "سلام"), ("lv", "cp1257", "Rīga")):
            self.assertEqual(subtitles._decode_sidecar(line.encode(page), language), line)

    def test_track_ordinals_skip_unplayable_streams_and_subtitle_bitmaps(self):
        audio = {"codec_type": "audio", "codec_name": "ac3", "channels": 6, "sample_rate": "48000"}
        data = {"streams": [
            {**audio, "index": 2, "sample_rate": "0", "disposition": {"default": 1}},
            {"codec_type": "subtitle", "index": 3, "codec_name": "dvd_subtitle"},
            {**audio, "index": 4, "tags": {"language": "eng", "title": "Main"}},
            {"codec_type": "subtitle", "index": 5, "codec_name": "ass", "tags": {"title": "Forced dialogue"}},
            {**audio, "index": 6, "channels": 0},
            {**audio, "index": 8, "tags": {"language": "qaa", "title": "C:\\private\\file"}},
        ]}
        tracks, selected, changed = _audio_choices(data, 3)
        self.assertEqual((selected, changed), (8, True))
        self.assertEqual([(t["index"], t["label"], t["selected"]) for t in tracks],
                         [(1, "English: Main (5.1 AC-3)", False), (3, "QAA (5.1 AC-3)", True)])
        [track] = subtitles.embedded_subtitles(data)
        self.assertEqual(track.public(), {"key": "e5", "label": "Track 2: Forced dialogue", "language": "",
                                          "source": "embedded", "default": False, "forced": True})


class SubtitleConversionTests(unittest.TestCase):
    vtt = b"WEBVTT\n\n00:02.000 --> 00:03.000\nA cue\n"

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def read(self, service, film="film-a", stream=1, *, track=None, cancel=None):
        return service.read(film, (1, 2), str(self.root / (film + ".mkv")),
                            track or subtitles.Subtitle(f"e{stream}", "Subtitle", "", stream=stream),
                            current=lambda: True, cancel=cancel or threading.Event())

    def write_vtt(self, args, *, timeout, cancelled):
        self.assertFalse(cancelled())
        Path(args[-1]).write_bytes(self.vtt)
        return True

    def test_embedded_mapping_and_timeout_and_sidecar_timeout(self):
        runner = mock.Mock(side_effect=self.write_vtt)
        service = subtitles.ComputerSubtitles(self.root / "cache", ffmpeg=lambda: "ffmpeg", runner=runner)
        self.assertEqual(self.read(service, stream=7), self.vtt)
        args, = runner.call_args.args
        self.assertEqual(runner.call_args.kwargs["timeout"], 300)
        self.assertEqual(args.count("-map"), 1)
        self.assertEqual(args[args.index("-map") + 1], "0:7")
        for flag in ("-vn", "-an", "-dn"):
            self.assertLess(args.index(flag), args.index("-i"))
        self.assertNotIn("-probesize", args)
        self.assertNotIn("-analyzeduration", args)
        self.assertEqual(self.read(service, stream=7), self.vtt)
        runner.assert_called_once()

        srt = self.root / "Film.en.srt"
        srt.write_text(_SRT, encoding="utf-8")
        sidecar = subtitles.Subtitle("f1", "English", "en", rel=srt.name, path=str(srt), demuxer="srt")
        self.assertEqual(self.read(service, track=sidecar), self.vtt)
        self.assertEqual(runner.call_args.kwargs["timeout"], 60)

    def blocking_conversion(self):
        started = threading.Event()
        def run(args, *, timeout, cancelled):
            Path(args[-1]).write_bytes(self.vtt)
            started.set()
            deadline = time.monotonic() + 5
            while not cancelled() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(cancelled(), "Conversion was never cancelled")
            return False
        return started, run

    def test_new_choice_cancels_the_old_conversion(self):
        for film, stream in (("film-a", 2), ("film-b", 1)):
            with self.subTest(film=film, stream=stream):
                started, block = self.blocking_conversion()
                def convert(args, **options):
                    run = self.write_vtt if started.is_set() else block
                    return run(args, **options)

                runner = mock.Mock(side_effect=convert)
                cache = self.root / f"{film}-{stream}"
                service = subtitles.ComputerSubtitles(cache, ffmpeg=lambda: "ffmpeg", runner=runner)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    old = pool.submit(self.read, service)
                    self.assertTrue(started.wait(3))
                    with self.assertRaises(subtitles.ApiError) as same:
                        self.read(service)
                    self.assertTrue(same.exception.retryable)
                    new = pool.submit(self.read, service, film, stream)
                    with self.assertRaises(ConnectionAbortedError):
                        old.result(3)
                    self.assertEqual(new.result(3), self.vtt)
                self.assertEqual(runner.call_count, 2)
                self.assertEqual(len(list(cache.glob("*.vtt"))), 1)
                self.assertEqual(list(cache.glob("*.part")), [])

    def test_disconnect_and_shutdown_cancel_conversion(self):
        for shutting_down in (False, True):
            with self.subTest(shutting_down=shutting_down):
                started, runner = self.blocking_conversion()
                cache = self.root / str(shutting_down)
                service = subtitles.ComputerSubtitles(cache, ffmpeg=lambda: "ffmpeg", runner=runner)
                disconnected = threading.Event()
                cancel = _RequestCancel(disconnected.is_set)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    read = pool.submit(self.read, service, cancel=cancel)
                    self.assertTrue(started.wait(3))
                    if shutting_down:
                        self.assertTrue(service.shutdown(3))
                    else:
                        disconnected.set()
                    with self.assertRaises(subtitles.ApiError if shutting_down else ConnectionAbortedError):
                        read.result(3)
                self.assertEqual(list(cache.iterdir()), [])


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg and ffprobe are required.")
class ComputerSubtitleTests(unittest.TestCase):
    setUpClass = classmethod(media_tests.ComputerMediaTests.setUpClass.__func__)
    index = media_tests.ComputerMediaTests.index
    request = media_tests.ComputerMediaTests.request
    play = media_tests.ComputerMediaTests.play
    request_timeout = 35

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.folder = self.root / "Approved"
        self.folder.mkdir()
        self.folders = ComputerFolders(self.root / "state" / "folders.json", ffprobe=lambda _: FFPROBE)
        self.saved = self.folders.add(str(self.folder))
        self.worker = ComputerVideo(self.root / "cache" / "computer-video", ffmpeg=lambda: FFMPEG,
                                    encoder_probe=lambda *_: False)
        self.worker.encoders[FFMPEG] = "libx264"
        self.media = ComputerMedia(video=self.worker)
        self.addCleanup(self.media.shutdown, 5)
        self.enterContext(mock.patch.multiple(server, COMPUTER_FOLDERS=self.folders, COMPUTER_MEDIA=self.media))
        self.enterContext(mock.patch.object(server, "rate_limit", return_value=True))
        self.auth = {"X-WorldMedia-Token": server.SESSION_TOKEN}
        self.mutation = {**self.auth, "Origin": self.origin, "Content-Type": "application/json"}

    def source(self, path, *, probed=False, **fields):
        self.identity = self.index(path, kind="video", ext=path.suffix[1:], probed=probed, **fields)
        return self.identity

    def answer(self, **fields):
        status, body = self.play(**fields)
        self.assertEqual(status, 200, body)
        self.last_play = body
        return body["data"]

    def subtitle_url(self, key):
        return subtitles.SUBTITLE_ROUTE + "?" + urlencode({"entry": self.identity, "key": key})

    def read_track(self, track):
        status, headers, body = self.request("GET", self.subtitle_url(track["key"]), self.auth)
        self.assertEqual(status, 200, body)
        self.assertEqual(headers["Content-Type"], "text/vtt; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertTrue(body.startswith(b"WEBVTT"))
        return body.decode("utf-8")

    def native_fixture(self):
        path = self.folder / "Film.mp4"
        ff("-f", "lavfi", "-i", "color=size=96x64:rate=10", "-t", "4", "-c:v", "libx264", path)
        self.source(path)
        return path

    @staticmethod
    def fixture_audio(*, silent_first):
        tone = "sine=frequency=730:sample_rate=48000"
        quiet = "anullsrc=r=48000:cl=mono"
        return (quiet, tone) if silent_first else (tone, quiet)

    def segment(self, answer, n):
        url = answer["url"].rsplit("/", 1)[0] + f"/seg/{n}.ts"
        status, _, body = self.request("GET", url, self.auth)
        self.assertEqual(status, 200, body[:200])
        path = self.root / f"segment-{n}.ts"
        path.write_bytes(body)
        return path

    @staticmethod
    def level(path, *mapping):
        pcm = array("h", ff("-i", path, *mapping, "-vn", "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "-"))
        return math.sqrt(sum(sample * sample for sample in pcm) / len(pcm))

    def test_mkv_track_lists_and_single_probe_for_native_and_hls(self):
        cue = self.root / "cue.srt"
        cue.write_text(_SRT, encoding="utf-8")
        path = self.folder / "Sample.mkv"
        tone, quiet = self.fixture_audio(silent_first=False)
        ff("-f", "lavfi", "-i", "color=size=96x64:rate=10", "-f", "lavfi", "-i", tone,
           "-f", "lavfi", "-i", quiet, "-i", cue, "-map", "0:v", "-map", "1:a", "-map", "2:a",
           "-map", "3:s", "-map", "3:s", "-c:v", "libx264", "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt",
           "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=ger", "-metadata:s:a:1", "title=Commentary",
           "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=ger", "-disposition:a:0", "default",
           "-disposition:a:1", "0", "-disposition:s:0", "default", "-disposition:s:1", "forced", "-t", "4", path)
        self.source(path)
        expected_audio = [
            {"index": 0, "label": "English (Mono AAC)", "language": "en", "codec": "aac", "channels": 1,
             "default": True, "selected": True},
            {"index": 1, "label": "German: Commentary (Mono AC-3)", "language": "de", "codec": "ac3", "channels": 1,
             "default": False, "selected": False},
        ]
        expected_subtitles = [
            {"key": "e3", "label": "English", "language": "en", "source": "embedded", "default": True, "forced": False},
            {"key": "e4", "label": "German", "language": "de", "source": "embedded", "default": False, "forced": True},
        ]
        with mock.patch.object(self.folders.library, "_runner", wraps=run_ffprobe) as runner:
            native = self.answer()
            native_answer = self.last_play
            self.assertIn("/media/", native["url"])
            self.assertEqual(native["audio_tracks"], expected_audio)
            self.assertEqual(native["subtitles"], expected_subtitles)
            runner.assert_called_once()
            runner.reset_mock()
            self.source(path)
            hls = self.answer(audio=1)
            self.assertTrue(hls["hls"])
            self.assertEqual(hls["subtitles"], expected_subtitles)
            for track in expected_audio:
                track["selected"] = not track["selected"]
            self.assertEqual(hls["audio_tracks"], expected_audio)
            self.assertIn("A cue", self.read_track(hls["subtitles"][0]))
            runner.assert_called_once()
        if os.environ.get("WORLDMEDIA_SUBTITLE_EXAMPLE") == "1":
            print("Subtitle sample play JSON", json.dumps(native_answer, ensure_ascii=False, separators=(",", ":")))

    def test_audio_play_omits_video_lists(self):
        path = self.folder / "Song.m4a"
        ff("-f", "lavfi", "-i", "sine=frequency=730:sample_rate=48000", "-t", "1", "-c:a", "aac", path)
        self.identity = self.index(path, ext="m4a", kind="audio", container="m4a", acodec="aac")
        answer = self.answer()
        self.assertEqual(answer["kind"], "audio")
        self.assertNotIn("audio_tracks", answer)
        self.assertNotIn("subtitles", answer)

    def test_native_mp4_keeps_default_and_hls_plays_requested_sound(self):
        path = self.folder / "Native.mp4"
        tone, quiet = self.fixture_audio(silent_first=False)
        ff("-f", "lavfi", "-i", "color=size=96x64:rate=10", "-f", "lavfi", "-i", tone,
           "-f", "lavfi", "-i", quiet, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "4",
           "-c:a", "aac", "-c:v", "libx264", "-disposition:a:0", "0", "-disposition:a:1", "default", path)
        self.source(path)
        for fields in ({}, {"audio": 1}):
            answer = self.answer(**fields)
            self.assertIn("/media/", answer["url"])
            self.assertEqual([t["index"] for t in answer["audio_tracks"] if t["selected"]], [1])
        self.assertLess(self.level(path, "-map", "0:a:1"), 10)
        answer = self.answer(audio=0)
        self.assertTrue(answer["hls"])
        self.assertEqual([t["index"] for t in answer["audio_tracks"] if t["selected"]], [0])
        self.assertGreater(self.level(self.segment(answer, 0)), 500)
        status, body = self.play(audio=2)
        self.assertEqual((status, body["error"]["code"]), (400, "INVALID_COMPUTER_AUDIO"))

    def test_indexed_two_audio_vob_plays_second_track_on_fresh_middle_seek(self):
        cell = self.root / "cell.vob"
        quiet, tone = self.fixture_audio(silent_first=True)
        ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25", "-f", "lavfi", "-i", quiet,
           "-f", "lavfi", "-i", tone, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "9",
           "-c:v", "mpeg2video", "-g", "12", "-c:a", "ac3", "-f", "vob", cell)
        path = self.folder / "Joined.vob"
        path.write_bytes(cell.read_bytes() * 2)
        self.source(path)
        answer = self.answer(audio=1)
        [session] = self.worker.sessions.values()
        self.assertGreater(session.movie.timeline.pieces, 1)
        self.assertEqual([t["index"] for t in answer["audio_tracks"] if t["selected"]], [1])
        self.assertIsNone(self.worker.run)
        self.assertGreater(self.level(self.segment(answer, 2)), 500)

    def test_embedded_offset_matches_native_picture_and_hls_picture(self):
        cue = self.root / "offset.srt"
        cue.write_text(_SRT, encoding="utf-8")
        path = self.folder / "Offset.mkv"
        ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=4", "-i", cue, "-map", "0:v", "-map", "1:s",
           "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,2)'", "-c:v", "libx264", "-crf", "10", "-c:s", "srt",
           "-output_ts_offset", "5", path)
        self.source(path)
        info = probe(path, "-show_format", "-show_packets", "-select_streams", "s:0")
        self.assertEqual(float(info["format"]["start_time"]), 5)
        self.assertEqual(float(info["packets"][0]["pts_time"]), 7)
        for convert in (False, True):
            with self.subTest(convert=convert):
                answer = self.answer(convert=convert)
                self.assertEqual(bool(answer.get("hls")), convert)
                self.assertEqual(answer["audio_tracks"], [])
                [track] = answer["subtitles"]
                vtt = self.read_track(track)
                self.assertIn("00:02.000 --> 00:03.000", vtt)
                [target] = self.media._subtitles.cache.glob("*.vtt")
                target.unlink()  # Decode again through each answer.
                video = self.segment(answer, 0) if convert else path
                frames = ff("-i", video, "-vf", "scale=1:1,format=gray", "-an", "-f", "rawvideo", "-")
                self.assertEqual(next(i for i, value in enumerate(frames) if value > 200), 20)

    def test_discovers_case_language_markers_and_only_approved_paths(self):
        self.native_fixture()
        for name in ("Film.srt", "film.En.VTT", "FILM.eng.forced.SRT", "Film.English.sdh.cc.ass",
                     "Film-ish.srt", "Film..en.srt", "Film.bitmap.SUB", "FILM.BITMAP.iDX"):
            (self.folder / name).write_text(_SRT, encoding="utf-8")
        subs = self.folder / "sUbS"
        subs.mkdir()
        (subs / "Film.ger.ssa").write_text(_SRT, encoding="utf-8")
        outside = self.root / "Outside"
        outside.mkdir()
        linked = outside / "Film.fra.srt"
        linked.write_text(_SRT, encoding="utf-8")
        media_tests.link_directory(self.folder / "Subtitles", outside)
        result = self.answer()["subtitles"]
        self.assertEqual({track["label"] for track in result},
                         {"Track 4 (file)", "English (file)", "English Forced (file)",
                          "English SDH CC (file)", "German (file)"})
        self.assertEqual([t["label"] for t in result if t["forced"]], ["English Forced (file)"])
        self.assertEqual(self.answer()["subtitles"], result)
        self.assertEqual(len({track["key"] for track in result}), len(result))
        if os.name != "nt":
            (self.folder / "Film.fra.srt").symlink_to(linked)
            self.assertEqual(self.answer()["subtitles"], result)

    def test_sidecar_belongs_to_longest_video_stem(self):
        self.native_fixture()
        sequel = self.folder / "FILM.part2.mkv"
        sequel.touch()
        (self.folder / "Film.Part2.en.srt").write_text(_SRT, encoding="utf-8")
        sub = self.folder / "Subs"
        sub.mkdir()
        (sub / "Film.Part2.pl.srt").write_text(_SRT, encoding="utf-8")
        self.assertEqual(self.answer()["subtitles"], [])
        self.source(sequel, probed=True)
        owned = subtitles.sidecar_subtitles(self.folders, self.saved, {"rel": sequel.name}, sequel)
        self.assertEqual([t.language for t in owned], ["en", "pl"])
        sequel.unlink()
        self.source(self.folder / "Film.mp4")
        self.assertEqual([t["language"] for t in self.answer()["subtitles"]], ["en", "pl"])

    def test_sidecar_count_and_size_limits(self):
        self.native_fixture()
        with (self.folder / "Film.000.srt").open("wb") as handle:
            handle.truncate(subtitles.SIDECAR_BYTES + 1)
        with (self.folder / "Film.001.srt").open("wb") as handle:
            handle.truncate(subtitles.SIDECAR_BYTES)
        self.assertEqual(len(self.answer()["subtitles"]), 1)
        for n in range(2, 45):
            (self.folder / f"Film.{n:03}.srt").write_text(_SRT, encoding="utf-8")
        self.assertEqual(len(self.answer()["subtitles"]), 40)

    def test_sidecar_encodings_tolerant_srt_and_ass_overrides(self):
        self.native_fixture()
        srt = "\n\n00:00:01,000 --> 00:00:02.100\ncaf\u00e9 m\u00fcsic\n\n00:00:01.500 --> 00:00:02,500\nOverlap\n\n"
        for language, encoding in (("eng", "cp1252"), ("deu", "utf-8"), ("ita", "utf-8-sig"), ("fra", "utf-16")):
            text = srt.replace("\n", "\r\n") if encoding == "cp1252" else srt
            (self.folder / f"Film.{language}.srt").write_bytes(text.encode(encoding))
        (self.folder / "Film.spa.ass").write_text(
            "[Script Info]\nScriptType: v4.00+\n[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            r"Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,{\an8\pos(12,16)}Plain" + "\n", encoding="utf-8")
        (self.folder / "Film.pol.sub").write_text("{1}{1}25.0\n{50}{75}MicroDVD\n{80}{95}Next\n", encoding="utf-8")
        tracks = {t["language"]: t for t in self.answer()["subtitles"]}
        for language in ("en", "de", "it", "fr"):
            with self.subTest(language=language):
                data = self.read_track(tracks[language])
                self.assertIn("caf\u00e9 m\u00fcsic", data)
                self.assertIn("Overlap", data)
                self.assertIn("00:01.000 --> 00:02.100", data)
                self.assertIn("00:01.500 --> 00:02.500", data)
        ass = self.read_track(tracks["es"])
        self.assertIn("Plain", ass)
        self.assertNotIn(r"\pos", ass)
        self.assertNotIn(r"\an8", ass)
        microdvd = self.read_track(tracks["pl"])
        self.assertIn("MicroDVD", microdvd)
        self.assertIn("00:02.000 --> 00:03.000", microdvd)
        (self.folder / "Film.deu.sub").write_bytes(bytes([0, 0, 1, 186]) + b"bitmap")
        (self.folder / "Film.por.sub").write_text("{20}{30}No FPS header\n{32}{37}Next\n", encoding="utf-8")
        tracks = self.answer()["subtitles"]
        self.assertEqual(len(tracks), 7)
        portuguese = next(t for t in tracks if t["language"] == "pt")
        self.assertIn("00:02.000 --> 00:03.000", self.read_track(portuguese))

    def test_route_errors_no_file_work_on_bad_shape_and_cache_lifetime(self):
        self.native_fixture()
        valid = self.folder / "Film.eng.srt"
        valid.write_text(_SRT, encoding="utf-8")
        broken = self.folder / "Film.fra.srt"
        broken.write_text("no cues", encoding="utf-8")
        tracks = {t["language"]: t for t in self.answer()["subtitles"]}
        url = self.subtitle_url(tracks["en"]["key"])
        with mock.patch.object(self.media, "subtitle", wraps=self.media.subtitle) as reader:
            for bad in (url + "&key=duplicate", url + "&x=1", subtitles.SUBTITLE_ROUTE + "?entry=../x&key=e1",
                        self.subtitle_url("a" * 65), self.subtitle_url("../x")):
                status, _, body = self.request("GET", bad, self.auth)
                self.assertEqual((status, json.loads(body)["error"]["code"]), (404, "COMPUTER_SUBTITLE_NOT_FOUND"))
            self.assertEqual(self.request("HEAD", url, self.auth)[0], 405)
            self.assertEqual(self.request("POST", url, self.mutation, b"{}")[0], 405)
            self.assertEqual(self.request("GET", url, {**self.auth, "Origin": "http://elsewhere.invalid"})[0], 403)
            self.assertEqual(self.request("GET", url, {"X-WorldMedia-Token": "bad"})[0], 403)
            self.assertEqual(self.request("GET", url)[0], 403)
            reader.assert_not_called()
        self.assertEqual(self.request("GET", self.subtitle_url("no_such_key"), self.auth)[0], 404)
        status, _, body = self.request("GET", self.subtitle_url(tracks["fr"]["key"]), self.auth)
        self.assertEqual((status, json.loads(body)["error"]),
                         (422, {"code": "COMPUTER_SUBTITLE_UNREADABLE", "message": "This subtitle cannot be read.",
                                "retryable": False}))
        service = self.media._subtitles
        with mock.patch.object(service, "ffmpeg", return_value=None):
            status, _, body = self.request("GET", url, self.auth)
        self.assertEqual(status, 503)
        self.assertTrue(json.loads(body)["error"]["retryable"])
        self.assertIn("A cue", self.read_track(tracks["en"]))
        with mock.patch.object(self.media, "_subtitles", subtitles.ComputerSubtitles(
                service.cache, ffmpeg=service.ffmpeg, runner=mock.Mock(side_effect=AssertionError("Unexpected decode")))):
            self.assertIn("A cue", self.read_track(tracks["en"]))
        valid.write_text(_SRT.replace("A cue", "A replaced cue"), encoding="utf-8")
        self.assertEqual(self.request("GET", url, self.auth)[0], 404)
        replacement = next(t for t in self.answer()["subtitles"] if t["language"] == "en")
        with mock.patch.object(subtitles, "CACHE_LIMIT", 64):
            self.assertIn("A replaced cue", self.read_track(replacement))
        self.assertEqual(len(list(service.cache.glob("*.vtt"))), 1)
        self.folders.remove(self.saved["id"])
        status, _, body = self.request("GET", self.subtitle_url(replacement["key"]), self.auth)
        self.assertEqual(status, 404)
        self.assertNotIn(str(self.folder), body.decode())
