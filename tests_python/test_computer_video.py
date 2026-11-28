"""Computer HLS contracts, including real packets, decoder output and on-host timings."""
from array import array
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from fractions import Fraction
import http.client
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from worldmedia_computer_media import ComputerMedia, TOKEN_TTL
import worldmedia_computer_video as video
from worldmedia_security import ApiError


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


bench = unittest.skipUnless(os.environ.get("WORLDMEDIA_VIDEO_BENCH") == "1", "Set WORLDMEDIA_VIDEO_BENCH=1.")


def eventually(condition):
    deadline = time.monotonic() + 4
    while not condition():
        if time.monotonic() >= deadline:
            raise AssertionError("Condition timed out")
        time.sleep(.01)


class GridTests(unittest.TestCase):
    def test_playlist(self):
        for duration, count, last in ((.5, 1, ".500"), (6, 1, "6.000"), (6.05, 1, "6.050"), (6.1, 2, ".100"), (3601.3, 601, "1.300")):
            lines = video.playlist(duration).decode().splitlines()
            self.assertEqual(lines[:4], ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:VOD",
                                         "#EXT-X-TARGETDURATION:6"])
            self.assertEqual(lines[4:-3:2], ["#EXTINF:6.000,"] * (count - 1))
            self.assertEqual(lines[5:-1:2], [f"seg/{i}.ts" for i in range(count)])
            self.assertEqual(lines[-3], f"#EXTINF:{float(last):.3f},")
            self.assertEqual(lines[-1], "#EXT-X-ENDLIST")

    def test_native_table(self):
        entry = dict(kind="video", ext="mp4", container="mov,mp4,m4a,3gp,3g2,mj2",
                     vcodec="h264", pix_fmt="yuv420p", acodec="aac")
        cases = [(dict(container=c, ext=c), False) for c in ("mp4", "m4v", "mov", "mkv", "webm")]
        cases += [(dict(vcodec=c), False) for c in ("vp8", "vp9", "av1")]
        cases += [(dict(acodec=c), False) for c in ("aac", "mp3", "opus", "vorbis", "flac", None)]
        cases += [(dict(vcodec=c), True) for c in ("mpeg1video", "mpeg2video", "mpeg4", "wmv3", "vc1",
                                                    "hevc", "dvvideo", "theora")]
        cases += [(dict(container=c), True) for c in ("avi", "mpeg", "mpegts", "asf", "flv", "3gp")]
        cases += [(dict(acodec=c), True) for c in ("ac3", "eac3", "dts", "truehd", "pcm_s16le", "wmav2", "mp2")]
        cases += [(dict(ext="3gp"), True), (dict(pix_fmt="yuv420p10le"), True), (dict(kind="audio"), False)]
        for updates, expected in cases:
            with self.subTest(updates=updates):
                self.assertIs(video.needs_video_conversion({**entry, **updates}), expected)

    def test_tracks_limits_and_even_dimensions(self):
        data = {"format": {"duration": "1"}, "streams": [
            dict(codec_type="video", width=4095, height=2159, index=0, avg_frame_rate="120"),
            dict(codec_type="audio", index=2, channels=2, sample_rate="48000"),
            dict(codec_type="audio", index=4, channels=8, sample_rate=48000, disposition={"default": 1})]}
        movie = video.movie_info("ffmpeg", "film.avi", data, None)
        self.assertEqual((movie.video, movie.audio, movie.channels, movie.fps), (0, 4, 6, 60))
        self.assertIn("scale=1920:1012", movie.filters)
        selected = video.movie_info("ffmpeg", "film.avi", data, 2)
        self.assertEqual((selected.audio, selected.channels), (2, 2))
        with self.assertRaises(ApiError):
            video.movie_info("ffmpeg", "film.avi", data, 0)
        data["streams"] = [dict(codec_type="video", width=127, height=95, index=0)]
        silent = video.movie_info("ffmpeg", "film.avi", data, None)
        self.assertNotIn("-c:a", video.command(silent, 0, "libx264"))


    def test_unusable_audio_is_excluded_even_when_default_or_requested(self):
        picture = dict(codec_type="video", width=96, height=64, index=0)
        good = dict(codec_type="audio", channels=2, sample_rate="48000", index=2)
        for params in (dict(channels=0, sample_rate="48000"), dict(channels=2, sample_rate="0"), dict(channels=2)):
            bad = dict(codec_type="audio", index=1, disposition={"default": 1}, **params)
            data = {"format": {"duration": "10"}, "streams": [picture, bad, good]}
            with self.subTest(params=params):
                self.assertEqual(video.movie_info("ffmpeg", "film.avi", data, None).audio, 2)
                with self.assertRaises(ApiError) as error:
                    video.movie_info("ffmpeg", "film.avi", data, 1)
                self.assertEqual(error.exception.code, "INVALID_COMPUTER_AUDIO")

    def test_selected_stream_ends_rotation_hdr_and_interlace(self):
        streams = [dict(index=0, codec_type="video", duration="26", start_time="100", width=1920,
                        height=1080, side_data_list=[{"rotation": -90}], color_transfer="smpte2084"),
                   dict(index=1, codec_type="audio", duration="30", start_time="101", channels=8, sample_rate=48000),
                   dict(index=2, codec_type="audio", duration="98", start_time="100")]
        for stale in (11, 51):
            data = {"streams": streams, "format": {"duration": str(stale), "start_time": "100"}}
            with mock.patch.object(video, "_hdr_filters", return_value=True):
                movie = video.movie_info("ffmpeg", "phone.mp4", data, 1)
            self.assertEqual(movie.duration, 31)
            self.assertIn("scale=608:1080", movie.filters)
            self.assertIn("tonemap=hable", movie.filters)
            self.assertIn("deint=interlaced", movie.filters)
            self.assertIn("5.1", video.command(movie, 0, "libx264"))

    def test_invalid_durations_use_bounded_packet_samples(self):
        size = 64_000_000
        head = [(100, 0, .04), (110, 1_000_000, .04)]
        track = dict(codec_type="video", width=720, height=480, index=2, id="0x1e0")
        for duration in (None, "N/A", "0", "86401", "20000"):
            for tail, expected, jump in (([(699, 1000, 1)], 630, False),
                                         ([(90, 1000, 1)], 672, True), ([], 672, False)):
                with self.subTest(duration=duration, tail=tail):
                    data = {"format": {"size": size, "duration": duration}, "streams": [dict(track, duration=duration)]}
                    with (mock.patch.object(video.os.path, "getsize", return_value=size),
                          mock.patch.object(video, "_packet_sample", side_effect=[head, tail]) as sample):
                        movie = video.movie_info("ffmpeg", "dvd.vob", data, None)
                    self.assertEqual((movie.duration, movie.duration_estimated, movie.timestamp_jump),
                                     (expected, True, jump))
                    first, last = [call.args for call in sample.call_args_list]
                    self.assertEqual((first[2:5], last[2:5]),
                                     ((0, 16 << 20, "i:0x1e0"), (size - (4 << 20), size, "i:0x1e0")))
                    self.assertEqual(first[6], last[6])

    def test_short_dvd_picture_windows_are_bounded_and_cached(self):
        size = 90_000_000
        data = {"format": {"size": size, "start_time": 100, "duration": 90, "format_name": "mpeg"},
                "streams": [dict(codec_type="video", index=1, id="0x1e0", start_time=100, width=720,
                                 height=480, duration=".033367"), dict(codec_type="audio", index=3, channels=2, sample_rate=48000)]}
        for mid, expected in (([], .033367), (None, .033367), ([(144, 900, .033367)], 90)):
            with mock.patch.object(video, "_packet_sample", side_effect=[[(t, 0, .04), (t+1, 2_000_000, .04)] for t in range(0, 10, 2)]):
                movie = video.movie_info("ffmpeg", "dvd.vob", data, None)
            with mock.patch.object(video, "_packet_sample", side_effect=[[(100, 10, .033367)], mid]) as sample:
                args = video.command(movie, 5, "h264_nvenc")
                video.command(movie, 5, "libx264")
            self.assertEqual(movie.picture_check.offsets[30], (expected, mid is None))
            self.assertEqual("-ss" in args, bool(mid))
            self.assertEqual(args.count("-i"), 1 if mid else 2)
            first, second = [call.args for call in sample.call_args_list]
            self.assertEqual([call[2] for call in (first, second)], [30_000_000, 45_000_000])
            self.assertEqual(first[6], second[6])
            for call in (first, second):
                self.assertLessEqual(call[3] - call[2], 2 << 20)
                self.assertEqual(call[4:6], ("i:0x1e0", "%+1"))
                self.assertLessEqual(call[6] - time.monotonic(), 5)

    def test_missing_dvd_picture_duration_probes_each_fresh_seek(self):
        size = 1_074_000_000
        data = {"format": {"size": size, "duration": 887.1, "format_name": "mpeg"},
                "streams": [dict(codec_type="video", index=1, id="0x1e0", width=720, height=480,
                                 duration="N/A", field_order="bb"), dict(codec_type="audio", index=2, duration=887.1, channels=2, sample_rate=48000)]}
        with mock.patch.object(video, "_packet_sample", side_effect=[[(t, 0, .04), (t+1, 2_000_000, .04)] for t in range(0, 10, 2)]):
            movie = video.movie_info("ffmpeg", "dvd.vob", data, None)
        with mock.patch.object(video, "_packet_sample", side_effect=[[(448, 0, .033)], [], None]) as sample:
            for n, inputs in ((74, 1), (74, 1), (130, 2), (90, 1), (74, 1), (130, 2)):
                args = video.command(movie, n, "libx264")
                self.assertEqual(args.count("-i"), inputs)
                self.assertEqual(args[args.index("-ss") + 1], str((n - 2) * 6))
        self.assertFalse(movie.duration_estimated)
        self.assertEqual(sample.call_count, 3)
        first = sample.call_args_list[0].args
        self.assertEqual(first[2], int(size * 444 / 887.1))
        self.assertEqual(first[3:6], (first[2] + (2 << 20), "i:0x1e0", "%+1"))

    def test_ps_length_verdict(self):
        ordered = [[0, 1], [3], [5], [7], [9]]
        cases = [
            ("ordinary", 1_000_000, 10, 100_000, ordered, ("trusted", "ordered")),
            ("unmeasured", 1_000_000, 10, 0, ordered, ("index", "unmeasured")),
            ("missing", 1_000_000, 0, 100_000, ordered, ("index", "missing")),
            ("unusable", 1_000_000, 90_209, 100_000, ordered, ("index", "missing")),
            ("11 Mbit/s", 13_750_000, 10, 1_375_000, ordered, ("trusted", "ordered")),
            ("above 11 Mbit/s", 13_750_001, 10, 1_375_000, ordered, ("index", "bitrate")),
            ("mux limit", 1_500_000, 10, 100_000, ordered, ("trusted", "ordered")),
            ("above mux limit", 1_500_001, 10, 100_000, ordered, ("index", "mux")),
            ("equal across windows", 1_000_000, 10, 100_000, [[0], [2, 4], [4], [6], [8]], ("index", "clock")),
            ("quarter goes back", 1_000_000, 10, 100_000, [[1], [0], [3], [5], [7]], ("index", "clock")),
            ("half second", 1_000_000, 10, 100_000, [[0], [2], [3], [5, 4.5], [7]], ("trusted", "ordered")),
            ("inside tail", 1_000_000, 10, 100_000, [[0], [2], [3], [4], [8, 7.49]], ("index", "clock")),
            ("no timestamps", 1_000_000, 10, 100_000, [[0], [2], [None]], ("index", "unreadable")),
            ("DVD missing picture", 1_073_000_000, 142.4, 8_000_000, ordered, ("index", "bitrate")),
        ]
        for middle in (14.46, .5):
            times = [[.5], [7.5], [middle], [7.5], [14.46]]
            cases.extend([
                ("repeat by rate", 1_200_128, 14.005333, 42_103, times, ("index", "mux")),
                ("repeat by clock", 1_200_128, 14.005333, 85_000, times, ("index", "clock")),
            ])
        for name, size, reported, rate, times, expected in cases:
            with self.subTest(name=name, times=times):
                windows = [video._window([(t, 0, .04) for t in stamps]) for stamps in times]
                self.assertEqual(video._ps_length_verdict(size, reported, rate, windows), expected)

    def test_high_rate_dvd_indexes_with_missing_or_short_picture(self):
        data = {"format": {"size": 1_073_000_000, "duration": 142.4, "format_name": "mpeg"},
                "streams": [dict(index=0, codec_type="video", width=720, height=480),
                            dict(index=1, codec_type="audio", duration=142.4, channels=2, sample_rate=48000)]}
        for picture in ("N/A", .04):
            data["streams"][0]["duration"] = picture
            for pieces in (1, 4):
                with (self.subTest(picture=picture, pieces=pieces),
                      mock.patch.object(video, "_packet_sample", side_effect=[[(t, 0, .04), (t+1, 2_000_000, .04)] for t in range(0, 10, 2)]),
                      mock.patch.object(video, "_timeline", return_value=video.Timeline(1073, (), pieces)) as scan):
                    movie = video.movie_info("ffmpeg", "dvd.vob", data, None)
                    scan.assert_called_once()
                    self.assertEqual((movie.duration, movie.duration_estimated, movie.timestamp_jump),
                                     (1073, False, pieces > 1))
                    if pieces == 1:
                        self.assertEqual(movie.video_end, 1073)
                        args = video.command(movie, 100, "libx264")
                        self.assertEqual(args.count("-i"), 1)
                        self.assertIn("-ss", args)

    def test_detection_discards_partial_output_on_probe_failure(self):
        process = mock.MagicMock()
        process.__enter__.return_value = process
        process.returncode = 1
        process.communicate.return_value = (b"dts_time=1|pos=0|duration_time=.04", None)
        with mock.patch.object(video, "_launch", return_value=process):
            args = ("ffprobe", "private.vob", 0, 1000, "0", "%", time.monotonic() + 3, lambda: False)
            self.assertIsNone(video._packet_sample(*args, require_success=True))
            self.assertEqual(video._packet_sample(*args), [(1, 0, .04)])
            process.communicate.side_effect = OSError()
            self.assertIsNone(video._packet_sample(*args, require_success=True))

    def test_failed_detection_retries_then_indexes(self):
        size = 50_000_000
        data = {"format": {"size": size, "duration": 60, "format_name": "mpeg"},
                "streams": [dict(index=0, codec_type="video", width=96, height=64)]}
        for retry, duration in (([(4, 0, .04)], 60), ([], 100)):
            samples = [[(0, 0, .04), (1, 1_000_000, .04)], *[[(t, 0, .04)] for t in (2, 2.5, 3)], None, retry]
            with (mock.patch.object(video, "_packet_sample", side_effect=samples) as sample,
                  mock.patch.object(video, "_timeline", return_value=video.Timeline(100, (), 5)) as index):
                movie = video.movie_info("ffmpeg", "retry.vob", data, None)
            self.assertEqual(index.call_count, int(not retry))
            self.assertEqual((movie.duration, movie.duration_estimated), (duration, False))
            ranges = [c.args[2:4] for c in sample.call_args_list]
            self.assertEqual([start for start, _ in ranges[:4]], [0, size // 4, size // 2, size * 3 // 4])
            self.assertEqual(ranges[4:], [(size - (2 << 20), size)] * 2)
            self.assertTrue(all(0 < end - start <= 2 << 20 for start, end in ranges))

    def test_ps_length_log_and_seek(self):
        streams = [dict(index=0, codec_type="video", width=96, height=64)]
        cases = [
            (100, None, "trusted", "ordered", 100, False),
            (20, video.Timeline(50, (), 1), "indexed", "mux", 50, False),
            (20, video.Timeline(50, (), 2), "indexed", "mux", 50, True),
            (20, None, "estimated", "mux", 62.5, True),
        ]
        for reported, timeline, verdict, reason, seconds, jump in cases:
            data = {"format": {"size": 5_000_000, "duration": reported, "format_name": "mpeg"}, "streams": streams}
            samples = [[(0, 0, .04), (1, 100_000, .04)], *[[(t, 0, .04)] for t in (4, 8, 12, 16)]]
            with (self.subTest(verdict=verdict, jump=jump), self.assertLogs(video.__name__, level="WARNING") as logs,
                  mock.patch.object(video, "_packet_sample", side_effect=samples),
                  mock.patch.object(video, "_timeline", return_value=timeline) as scan):
                movie = video.movie_info("ffmpeg", "private.vob", data, None)
            self.assertEqual(scan.call_count, int(verdict != "trusted"))
            self.assertEqual((movie.duration, movie.duration_estimated, movie.timestamp_jump),
                             (seconds, verdict == "estimated", jump))
            self.assertEqual(len(logs.records), 1)
            self.assertRegex(logs.records[0].getMessage(),
                             rf"^Computer video length: container=mpeg size=5000000 reported={reported}\.0 "
                             rf"head_rate=100000\.000 verdict={verdict} reason={reason} "
                             rf"pieces={timeline.pieces if timeline else 0} seconds={movie.duration} probe_ms=\d+$")
            self.assertEqual("-ss" in video.command(movie, 4, "libx264"), not jump)

    def test_anchor_stamp_is_independent_of_the_probe_wrap_epoch(self):
        for epoch in (-1, 0, 1):
            lines = [f"pts_time={epoch * video._PTS_WRAP + t:.6f}|pos={i}|duration_time=1|flags=K".encode()
                     for i, t in enumerate((1, 2, 3))]
            timeline = video._read_timeline(lines, 1)
            self.assertEqual(timeline.duration, 3)
            self.assertEqual([(a.time, a.stamp) for a in timeline.anchors], [(0, 1), (2, 3)])

    def test_timeline_cache_eviction_and_source_change(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        index = video.Timeline(5, (), 2)
        with (mock.patch.object(video, "_indexes", video.OrderedDict()),
              mock.patch.object(video, "_probe_timeline", return_value=index) as scan):
            def prepare(number):
                path = root / str(number)
                if not path.exists():
                    path.write_bytes(b"first")
                return video._timeline("ffprobe", str(path), {"index": 0}, threading.Event())

            for number in range(32):
                self.assertIs(prepare(number), index)
            prepare(0)
            prepare(32)
            prepare(0)
            self.assertEqual(scan.call_count, 33)
            prepare(1)
            (root / "0").write_bytes(b"changed")
            prepare(0)
            self.assertEqual(scan.call_count, 35)
            self.assertEqual(len(video._indexes), 32)

    def test_index_store_prunes_the_least_recently_used_file(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        worker = video.ComputerVideo(root / "cache", ffmpeg=lambda: None, index_limit=2)
        store = worker.index_store
        keys = [((str(root / str(number)), 200, 123), 0) for number in range(3)]
        index = video.Timeline(5.0, (video.Anchor(0, 1, 100, 0),), 2, True)
        store.write(keys[0], index)
        store.write(keys[1], index)
        os.utime(store._path(keys[0]), ns=(1_000_000_000, 1_000_000_000))
        os.utime(store._path(keys[1]), ns=(2_000_000_000, 2_000_000_000))
        self.assertEqual(store.read(keys[0]), index)
        store.write(keys[2], index)
        self.assertEqual(set(store.directory.glob("*.json")), {store._path(keys[0]), store._path(keys[2])})

    def test_detection_and_index_caches_use_path_size_and_nanosecond_mtime(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        paths = [root / name for name in ("a.vob", "b.vob", "c.vob")]
        stamp = 1_700_000_000_000_000_000
        def touch(path, when):
            os.utime(path, ns=(when, when))
            self.assertEqual(path.stat().st_mtime_ns, when)

        for path in paths:
            path.write_bytes(bytes(4000))
            touch(path, stamp)
        cancel = threading.Event()
        def measured(probe, source, start, end, *args, **kwargs):
            return [(start, 0, .04)]
        with (mock.patch.object(video, "_packet_sample", side_effect=measured) as sample,
              mock.patch.object(video, "_probe_timeline", return_value=video.Timeline(10, (), 1)) as scan):
            def prepare(path):
                video._ps_samples("ffprobe", path, path.stat().st_size, "0", cancel)
                video._timeline("ffprobe", path, {"index": 0}, cancel)
            for path in paths * 2:
                prepare(path)
            self.assertEqual((sample.call_count, scan.call_count), (15, 3))
            touch(paths[0], stamp + 100)
            prepare(paths[0])
            paths[1].write_bytes(bytes(5000))
            touch(paths[1], stamp)
            prepare(paths[1])
            self.assertEqual((sample.call_count, scan.call_count), (25, 5))

    def test_readable_retry_on_later_prepare_keeps_known_index(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        path = root / "movie.vob"
        path.write_bytes(bytes(1_000_000))
        samples = [[], [], [(0, 0, .04), (1, 20_000, .04)], *[[(t, 0, .04)] for t in range(2, 6)]]
        data = {"format": {"format_name": "mpeg", "duration": 90},
                "streams": [dict(index=0, codec_type="video", width=96, height=64)]}
        with (mock.patch.object(video, "_packet_sample", side_effect=samples),
              mock.patch.object(video, "_probe_timeline", return_value=video.Timeline(130, (), 2)) as scan):
            for _ in range(2):
                movie = video.movie_info("ffmpeg", str(path), data, None)
                self.assertEqual((movie.duration, movie.timestamp_jump), (130, True))
            scan.assert_called_once()

    def test_failed_read_and_index_estimate_from_bytes(self):
        data = {"format": {"format_name": "mpeg", "size": 5_000_000, "duration": 20, "bit_rate": 800_000},
                "streams": [dict(index=0, codec_type="video", width=96, height=64)]}
        with (mock.patch.object(video, "_packet_sample", return_value=None) as sample,
              mock.patch.object(video, "_timeline", return_value=None) as scan):
            movie = video.movie_info("ffmpeg", "unreadable.vob", data, None)
        self.assertEqual(sample.call_count, 2)
        scan.assert_called_once()
        self.assertEqual((movie.duration, movie.duration_estimated, movie.timestamp_jump), (62.5, True, True))
        self.assertNotIn("-ss", video.command(movie, 4, "libx264"))

    def test_failed_ps_index_without_usable_estimate_logs_refusal(self):
        data = {"format": {"format_name": "mpeg", "size": 100, "bit_rate": 100_000},
                "streams": [dict(index=0, codec_type="video", width=96, height=64)]}
        with (self.assertLogs(video.__name__, level="WARNING") as logs, self.assertRaises(ApiError),
              mock.patch.object(video, "_packet_sample", return_value=None),
              mock.patch.object(video, "_timeline", return_value=None)):
            video.movie_info("ffmpeg", "private.vob", data, None)
        self.assertEqual(len(logs.records), 1)
        self.assertRegex(logs.records[0].getMessage(), r" reported=none head_rate=0\.000 verdict=refused "
                         r"reason=missing pieces=0 seconds=0 probe_ms=\d+$")

    def test_estimate_cancellation_and_unreadable_packets(self):
        data = {"format": {"size": 500_000, "bit_rate": 100_000},
                "streams": [dict(index=0, codec_type="video", width=96, height=64)]}
        cancel = threading.Event()
        cancel.set()
        with mock.patch.object(video, "_launch", side_effect=OSError) as launch:
            with self.assertRaises(ConnectionAbortedError):
                video.movie_info("ffmpeg", "missing.vob", data, None, cancel=cancel)
            launch.assert_not_called()
            cancel.clear()
            movie = video.movie_info("ffmpeg", "missing.vob", data, None, cancel=cancel)
        self.assertEqual((movie.duration, movie.duration_estimated), (42, True))

    def test_single_packet_sample_uses_the_fallback_or_refuses(self):
        packet = [(-4.757689, 32.0, .04)]
        streams = [dict(index=0, codec_type="video", width=96, height=64),
                   dict(index=1, codec_type="audio", channels=2, sample_rate=48000)]
        data = {"format": {"size": 1_200_128, "bit_rate": 685526}, "streams": streams}
        with (mock.patch.object(video.os.path, "getsize", return_value=1_200_128),
              mock.patch.object(video, "_packet_sample", return_value=packet)):
            movie = video.movie_info("ffmpeg", "repeated.vob", data, None)
        self.assertEqual((movie.duration, movie.duration_estimated, movie.timestamp_jump),
                         (14.706, True, False))
        data = {"format": {"size": 700, "bit_rate": 342763}, "streams": streams}
        with (mock.patch.object(video.os.path, "getsize", return_value=700),
              mock.patch.object(video, "_packet_sample", return_value=packet)):
            with self.assertRaises(ApiError) as refused:
                video.movie_info("ffmpeg", "truncated.vob", data, None)
        self.assertEqual((refused.exception.status, refused.exception.code), video._DECODE[:2])

    @unittest.skipUnless(os.name == "nt", "Windows Job Objects")
    def test_job_kills_child_after_hard_parent_exit(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        program = ("import sys,time,worldmedia_computer_video as v;"
                   "p=v._launch([sys.executable,'-c','import time;time.sleep(30)']);"
                   "print(p.pid,flush=True);time.sleep(30)")
        with subprocess.Popen([sys.executable, "-B", "-c", program], stdout=subprocess.PIPE) as parent:
            try:
                pid = int(parent.stdout.readline())
                handle = wintypes.HANDLE(kernel.OpenProcess(0x100001, False, pid))
                self.assertTrue(handle)
                try:
                    parent.kill()
                    parent.wait(3)
                    self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                finally:
                    kernel.TerminateProcess(handle, 1)
                    kernel.CloseHandle(handle)
            finally:
                parent.kill()


class Process:
    stderr = None

    def __init__(self):
        self.code = None

    def kill(self):
        self.code = -1

    def poll(self):
        return self.code

    def wait(self):
        assert self.code is not None
        return self.code


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory())) / "computer-video"
        self.cache.mkdir()
        (self.cache / "old.tmp").write_bytes(b"old")
        self.now = 0
        self.starts = []
        self.children = []
        self.valid = True
        self.publish = True
        self.fail = False
        self.probe = mock.Mock(side_effect=lambda exe, enc, cancel: enc == "h264_qsv")
        self.worker = video.ComputerVideo(self.cache, ffmpeg=lambda: "ffmpeg", encoder_probe=self.probe,
                                          clock=lambda: self.now, launch=self.launch)
        self.assertFalse(self.cache.exists())
        self.addCleanup(self.worker.shutdown, 2)
        self.movie = video.Movie("ffmpeg", "file.vob", 600, 0, 1, 6, Fraction(30), "setsar=1")
        self.lease = SimpleNamespace(active=0, expires=TOKEN_TTL)
        self.register("a")

    def register(self, token):
        self.worker.register(token, self.movie, lambda: self.valid, self.lease)

    def launch(self, cmd, work):
        self.assertFalse(any(child.poll() is None for child in self.children))
        n = int(cmd[cmd.index("-start_number") + 1])
        self.starts.append((n, cmd[cmd.index("-c:v") + 1]))
        child = Process()
        self.children.append(child)
        if self.fail:
            child.code = 1
        elif self.publish:
            (work / f"{n}.ts").write_bytes(b"test")
            (work / f"{n+1}.ts").write_bytes(b"test")
        return child

    def get(self, n, token="a"):
        with self.worker.open(token, n) as (stream, size, mime):
            self.assertEqual((stream.read(), size, mime), (b"test", 4, "video/mp2t"))

    def test_one_process_seek_ahead_idle_expiry_and_shutdown(self):
        self.get(0)
        self.get(8)
        self.assertEqual([n for n, _ in self.starts], [0, 8])
        self.get(2)
        for n in range(3, 25):
            (self.cache / "a" / "work" / f"{n}.ts").write_bytes(b"test")
        eventually(lambda: self.worker.run is None)
        self.assertEqual(max(self.worker.sessions["a"].sizes), 22)
        self.register("b")
        self.get(1, "a")
        self.get(31, "b")
        self.now = 60
        eventually(lambda: self.worker.run is None)
        self.get(32, "b")
        self.lease.expires = self.now
        eventually(lambda: all(not (self.cache / key).exists() for key in ("a", "b")))
        self.lease.expires += TOKEN_TTL
        self.register("c")
        self.get(0, "c")
        self.assertTrue(self.worker.shutdown(2))
        self.assertFalse((self.cache / "c").exists())
        self.assertTrue(all(c.poll() is not None for c in self.children))

    def test_trim_preserves_recent_requests_and_removes_oldest(self):
        self.worker.limit = 8
        self.get(0)
        work = self.cache / "a" / "work"
        with self.worker.open("a", 0):
            for i in (1, 2):
                (work / f"{i}.ts").write_bytes(b"test")
            eventually(lambda: self.worker.run is None)
            with self.worker.open("a", 1):
                self.now = 31
                with self.assertRaises(ApiError) as error:
                    self.get(2)
                self.assertEqual(error.exception.status, 503)
                self.assertTrue((work.parent / "0.ts").exists())
                self.assertEqual(len(self.starts), 1)
        self.get(9)
        self.assertFalse((work.parent / "0.ts").exists())

    def test_registration_and_idle_release_preserve_the_running_encoder(self):
        self.probe.assert_not_called()
        self.get(0)
        first = self.worker.run
        self.register("b")
        (self.cache / "a" / "work" / "2.ts").write_bytes(b"test")
        self.get(2)
        self.worker.discard("b")
        (self.cache / "a" / "work" / "3.ts").write_bytes(b"test")
        self.get(3)
        self.assertIs(self.worker.run, first)
        self.register("c")
        self.get(4, "c")
        self.get(4, "a")
        self.assertEqual([n for n, _ in self.starts], [0, 4, 4])
        self.assertEqual(sum(p.poll() is None for p in self.children), 1)

    def test_waiter_ends_when_released_and_disconnected_seek_never_starts(self):
        self.publish = False
        with ThreadPoolExecutor(1) as pool:
            waiting = pool.submit(self.get, 0)
            eventually(lambda: self.worker.run is not None)
            self.register("b")
            self.worker.discard("a")
            with self.assertRaises(ApiError) as error:
                waiting.result(2)
            self.assertEqual(error.exception.status, 410)
        with self.assertRaises(ConnectionAbortedError), self.worker.open("b", 30, client_gone=lambda: True):
            pass
        self.assertEqual(len(self.starts), 1)

    def test_release_during_response(self):
        self.get(0)
        with self.worker.open("a", 0) as (stream, _, _):
            self.worker.discard("a")
            self.assertIsNotNone(self.children[-1].poll())
            self.assertFalse((self.cache / "a").exists())
            with self.assertRaises(ApiError) as gone:
                self.get(0)
            self.assertEqual(gone.exception.status, 410)
            self.assertEqual(stream.read(), b"test")

    def test_free_space_before_registration_start_and_while_running(self):
        free = video.MIN_FREE
        self.worker.free_space = lambda _: free
        self.get(0)
        free -= 1
        with self.assertRaises(ApiError) as error:
            self.register("b")
        self.assertEqual((error.exception.status, error.exception.message), video._DISK_FULL[::2])
        self.now = 5
        eventually(lambda: self.worker.run is None)
        with self.assertRaises(ApiError) as error:
            self.get(0)
        self.assertEqual(error.exception.status, 500)
        free += 1
        self.register("c")
        free -= 1
        with self.assertRaises(ApiError) as error:
            self.get(10, "c")
        self.assertEqual(error.exception.status, 500)
        self.assertEqual(len(self.starts), 1)

    def test_disk_watchdog_runs_while_folder_check_is_blocked(self):
        entered = threading.Event()
        resume = threading.Event()
        def validate():
            entered.set()
            return resume.wait(3)
        self.get(0)
        self.worker.sessions["a"].current = validate
        self.now = 5
        try:
            self.assertTrue(entered.wait(2))
            self.worker.free_space = lambda _: 0
            self.now = 10
            eventually(lambda: self.worker.run is None)
            self.assertTrue(self.worker.sessions["a"].disk_error)
        finally:
            resume.set()

    def test_clean_eof_is_permanent_and_head_only_reads_cache(self):
        with self.assertRaises(ApiError) as error, self.worker.open("a", 0, head=True):
            pass
        self.assertEqual(error.exception.status, 503)
        self.assertFalse(self.starts)
        def singleton(cmd, work):
            child = self.launch(cmd, work)
            (work / "1.ts").unlink()
            child.code = 0
            return child
        self.worker.launch = singleton
        self.get(0)
        for n in (1, 90, 1):
            with self.assertRaises(ApiError) as error:
                self.get(n)
            self.assertEqual(error.exception.status, 416)
        with self.worker.open("a", 0, head=True):
            pass
        self.assertEqual(len(self.starts), 2)

    def test_waiters_near_seek_and_superseded_request(self):
        self.get(0)
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.get, 3)
            other = pool.submit(self.get, 3)
            eventually(lambda: self.worker.sessions["a"].highest == 3)
            for i in range(1, 4):
                (self.cache / "a" / "work" / f"{i}.ts").write_bytes(b"test")
            first.result(3)
            other.result(3)
            self.assertEqual(len(self.starts), 1)
            pending = pool.submit(self.get, 5)
            eventually(lambda: self.worker.sessions["a"].highest == 5)
            self.get(12)
            with self.assertRaises(ApiError) as error:
                pending.result(3)
            self.assertEqual(error.exception.status, 503)

    def test_hardware_probe_once_and_mid_file_fallback(self):
        self.get(0)
        self.children[0].code = 1
        self.get(1)
        self.get(12)
        self.assertEqual(self.starts, [(0, "h264_qsv"), (1, "libx264"), (12, "libx264")])
        self.assertEqual([c.args[1] for c in self.probe.call_args_list], list(video.HARDWARE[:2]))
        self.assertFalse((self.cache / "a" / "0.ts").exists())
        self.register("b")
        self.get(0, "b")
        self.children[-1].code = 1
        self.get(1, "b")
        self.worker.discard("a")
        self.register("a")
        self.get(0)
        self.assertEqual(self.starts[-1][1], "libx264")
        self.valid = False
        with self.assertRaises(ApiError):
            self.get(13)
        self.assertFalse((self.cache / "a").exists())
        self.assertIsNotNone(self.children[-1].poll())

    def test_decoder_warnings_alongside_a_complete_segment(self):
        warnings = (b"Error while decoding stream #0:2: Invalid data found when processing input\n"
                    b"[mpeg2video] Invalid frame dimensions 0x0\n")
        def launch(cmd, work):
            script = ("import sys;sys.stderr.buffer.write(" + repr(warnings + b"#EXT-X-BYTERANGE:4@0\n")
                      + ");sys.stdout.buffer.write(b'test')")
            return video._launch([sys.executable, "-B", "-c", script], work, stdout=subprocess.PIPE)
        self.worker.launch = launch
        self.get(0)
        eventually(lambda: self.worker.run is None)
        session = self.worker.sessions["a"]
        self.assertEqual((session.failures, session.software, session.hardware_produced), (0, False, True))
        with self.assertRaises(ApiError) as ended:
            self.get(1)
        self.assertEqual(ended.exception.status, 416)

    def test_unreachable_estimated_seek_leaves_earlier_ranges_available(self):
        self.movie.duration_estimated = self.movie.timestamp_jump = True
        self.publish = False
        with mock.patch.object(video, "SEGMENT_WAIT", .25), self.assertRaises(ApiError) as end:
            self.get(5)
        self.assertEqual(end.exception.status, 503)
        s = self.worker.sessions["a"]
        self.assertIsNone(s.end)
        self.publish = True
        self.get(0)

    def test_indexed_seek_preserves_cached_segments_in_both_directions(self):
        self.movie.timestamp_jump = True
        self.movie.timeline = video.Timeline(300, (video.Anchor(30, 5, 3000, 1),), 2)
        self.movie.video_id, self.movie.audio_id = "0x1e0", "0x80"
        self.get(0)
        with self.worker.open("a", 0) as (reader, _, _):
            self.get(20)
            self.assertEqual(reader.read(), b"test")
            self.assertTrue((self.cache / "a" / "0.ts").exists())
        self.get(40)
        self.assertTrue((self.cache / "a" / "20.ts").exists())
        self.get(0)
        self.assertEqual(self.worker.sessions["a"].sizes, {0: 4, 1: 4, 20: 4, 21: 4, 40: 4, 41: 4})

    def test_clean_empty_start_retries_then_reports_position_specific_error(self):
        commands = []
        def empty(cmd, work):
            commands.append(cmd)
            child = Process()
            child.code = 0
            return child
        self.worker.launch = empty
        for n, status in ((0, 500), (32, 500), (98, 416)):
            with self.assertRaises(ApiError) as error:
                self.get(n)
            self.assertEqual((error.exception.status, error.exception.retryable), (status, False))
            self.assertEqual(len(commands), 2)
            self.assertEqual("-ss" in commands[0], n > 2)
            self.assertNotIn("-ss", commands[1])
            commands.clear()

    def test_confirmed_picture_retries_an_empty_fast_seek_from_zero(self):
        self.movie.video_end = .04
        self.movie.picture_check = video.PictureCheck(600_000, 0, "v:0")
        commands = []
        def launch(cmd, work):
            commands.append(cmd)
            self.publish = len(commands) == 2
            child = self.launch(cmd, work)
            child.code = 0
            return child
        self.worker.launch = launch
        with mock.patch.object(video, "_packet_sample", return_value=[(120, 0, .04)]) as sample:
            self.get(20)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0][commands[0].index("-ss") + 1], "108")
        self.assertNotIn("-ss", commands[1])
        sample.assert_called_once()

    def test_short_and_stalled_seeks_retry_before_answering(self):
        for failure in ("one segment", "timeout", "empty"):
            with self.subTest(failure=failure):
                self.register("a")
                commands = []
                def launch(cmd, work):
                    commands.append(cmd)
                    if len(commands) == 1:
                        child = Process()
                        if failure == "one segment":
                            (work / "20.ts").write_bytes(b"bad!")
                        if failure != "timeout":
                            child.code = 0
                        return child
                    return self.launch(cmd, work)
                self.worker.launch = launch
                with mock.patch.object(video, "SEGMENT_WAIT", 1):
                    self.get(20)
                    self.get(21)
                self.assertEqual(len(commands), 2)
                self.assertIn("-ss", commands[0])
                self.assertNotIn("-ss", commands[1])

    def test_indexed_seek_uses_preroll_and_retries_from_zero(self):
        self.movie.timeline = video.Timeline(150, (video.Anchor(117, 17, 8000, 1), video.Anchor(119, 19, 9000, 1)), 2)
        self.movie.video_id, self.movie.audio_id = "0xe0", "0x80"
        self.movie.timestamp_jump = True
        args = video.command(self.movie, 20, "libx264")
        retry = video.command(self.movie, 20, "libx264", retry=True)
        self.assertEqual(args[args.index("-start") + 1], "8000")
        self.assertNotIn("-start", retry)
        self.assertNotIn("-ss", retry)

    def test_new_prepare_and_shutdown_cancel_pending_prepare(self):
        for action in ("new play", "shutdown"):
            with self.subTest(action=action):
                started = threading.Event()
                first = threading.Event()

                def prepare(source, current, audio, cancel, probe_data):
                    if cancel is first:
                        started.set()
                        if cancel.wait(2):
                            raise ConnectionAbortedError()
                        self.fail("Pending prepare was not cancelled")
                    return self.movie

                with mock.patch.object(self.worker, "_prepare", side_effect=prepare), ThreadPoolExecutor(1) as pool:
                    pending = pool.submit(self.worker.prepare, "file", lambda: True, None, first)
                    self.assertTrue(started.wait(1))
                    self.worker.discard("a")
                    self.assertFalse(first.is_set())
                    if action == "new play":
                        self.worker.prepare("new file", lambda: True, None, threading.Event())
                    else:
                        self.assertTrue(self.worker.shutdown(2))
                    with self.assertRaises(ConnectionAbortedError):
                        pending.result(timeout=2)

    def test_release_cancels_picture_check(self):
        self.movie.picture_check = video.PictureCheck(600_000, 0, "v:0")
        probing = threading.Event()
        def sample(*args):
            probing.set()
            eventually(args[-1])
            raise ConnectionAbortedError()
        with mock.patch.object(video, "_packet_sample", side_effect=sample), ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.get, 5)
            self.assertTrue(probing.wait(2))
            self.worker.discard("a")
            with self.assertRaises(ApiError) as error:
                pending.result(timeout=2)
            self.assertEqual(error.exception.status, 410)
            self.assertFalse(self.starts)

    def test_three_failed_starts(self):
        self.fail = True
        self.worker.sessions["a"].software = True
        with self.assertLogs(video.__name__, "WARNING") as logged:
            for status in (503, 503, 500, 500):
                with self.assertRaises(ApiError) as error:
                    self.get(0)
                self.assertEqual((error.exception.status, error.exception.retryable), (status, status == 503))
        self.assertEqual(sum("retrying segment" in line for line in logged.output), 3)
        self.assertEqual(sum("segment failed" in line for line in logged.output), 3)
        self.assertEqual(len(self.starts), 6)


def ff(*args, cwd=None, timeout=60):
    return subprocess.check_output([FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
                                   timeout=timeout, cwd=cwd)


def probe(path, *options):
    return json.loads(subprocess.check_output([FFPROBE, "-v", "error", *options, "-of", "json", str(path)], timeout=15))


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg and ffprobe are required.")
class RealVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = tempfile.TemporaryDirectory()
        cls.addClassCleanup(scratch.cleanup)
        cls.root = Path(scratch.name)
        cls.dvd = cls.root / "Movie.vob"
    def make_dvd(self):
        if self.dvd.is_file():
            return
        ff("-f", "lavfi", "-i", "testsrc2=size=720x480:rate=60", "-f", "lavfi", "-i",
           "sine=frequency=550:sample_rate=48000", "-t", "40", "-vf", "tinterlace=interleave_top,setsar=32/27",
           "-af", "volume='between(mod(t,3),0.75,1.35)':eval=frame", "-flags", "+ildct+ilme",
           "-top", "1", "-g", "15", "-q:v", "5", "-c:v", "mpeg2video", "-ac", "6", "-c:a", "ac3", "-f", "vob", self.dvd)

    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory())) / "video"
        self.worker = video.ComputerVideo(self.cache, ffmpeg=lambda: FFMPEG)
        self.media = ComputerMedia(video=self.worker)
        self.addCleanup(self.media.shutdown, 5)

    def register(self, path):
        movie = self.worker.prepare(str(path), path.is_file, None, threading.Event())
        token = str(time.monotonic_ns())
        self.worker.register(token, movie, path.is_file, SimpleNamespace(active=0, expires=math.inf))
        return token

    def get(self, token, n):
        with self.worker.open(token, n) as (handle, size, mime):
            self.assertEqual(handle.read(1), b"G")
            self.assertGreater(size, 188)
        return self.cache / token / f"{n}.ts"

    def check_packets(self, path, n):
        data = probe(path, "-show_packets", "-show_streams", "-read_intervals", "%+#150")
        v, a = data["streams"]
        self.assertEqual((v["codec_name"], v["pix_fmt"], v["width"], v["height"], v["sample_aspect_ratio"]),
                         ("h264", "yuv420p", 854, 480, "1:1"))
        self.assertAlmostEqual(v["width"]/v["height"], 16/9, delta=.002)
        self.assertEqual((a["codec_name"], a["channels"], a["sample_rate"]), ("aac", 6, "48000"))
        first = [next(p for p in data["packets"] if p["stream_index"] == s["index"]) for s in (v, a)]
        self.assertIn("K", first[0]["flags"])
        pts = float(first[0]["pts_time"])
        self.assertAlmostEqual(pts, n*6, delta=1/30)
        self.assertAlmostEqual(float(first[1]["pts_time"]), n*6, delta=1024/48000 + 1/90000)
        frames = probe(path, "-select_streams", "v:0", "-show_frames", "-read_intervals", "%+#2")["frames"]
        self.assertTrue(frames and all(f["interlaced_frame"] == 0 for f in frames))
        return pts

    @bench
    def test_continuity_picture_and_timed_tone(self):
        self.make_dvd()
        first = self.register(self.dvd)
        parts = [self.get(first, n) for n in range(6)]
        pts = [self.check_packets(path, n) for n, path in enumerate(parts)]
        # Keep the independent reference copies across supersession.
        parts = [Path(shutil.copyfile(part, self.cache / f"reference-{i}.ts")) for i, part in enumerate(parts)]
        second = self.register(self.dvd)
        for n in (3, 4, 1, 2):
            path = self.get(second, n)
            self.assertEqual(self.check_packets(path, n), pts[n])
        compare = self.cache / second / "4.ts"
        def gray(path, seconds, deinterlace=False):
            vf = ("yadif=mode=send_frame," if deinterlace else "") + "scale=96:54,format=gray"
            return ff("-i", path, "-ss", seconds, "-map", "0:v:0", "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-")
        ref, actual = gray(self.dvd, 27, True), gray(compare, 3)
        self.assertEqual(len(actual), 96*54)
        self.assertEqual(len(ref), len(actual))
        self.assertLess(sum(abs(a-b) for a, b in zip(ref, actual))/len(ref), 6)
        def tone(path, start):
            pcm = array("h", ff("-i", path, "-ss", start, "-t", 2, "-map", "0:a:0", "-ac", 1,
                                "-af", "aresample=8000,asetpts=N/SR/TB", "-ar", "8000", "-f", "s16le", "-"))
            onset = next(i for i, x in enumerate(pcm) if abs(x) > 500)
            wave = pcm[onset + 240:onset + 1840]
            crossings = sum(a <= 0 < b for a, b in zip(wave, wave[1:]))
            self.assertAlmostEqual(crossings * 5, 550, delta=8)
            return onset / 8000
        self.assertAlmostEqual(tone(self.dvd, 24), tone(compare, 0), delta=1024/48000 + 1/90000)
        parts[1:5] = [self.cache / second / f"{n}.ts" for n in (1, 2, 3, 4)]
        joined = self.cache / "joined.ts"
        with joined.open("wb") as out:
            for part in parts:
                with part.open("rb") as src:
                    shutil.copyfileobj(src, out)
        duration = float(probe(joined, "-show_format")["format"]["duration"])
        self.assertAlmostEqual(duration, 36, delta=.05)
        decode = subprocess.run([FFMPEG, "-v", "error", "-i", str(joined), "-map", "0:v", "-map", "0:a",
                                 "-f", "null", "-"], capture_output=True, timeout=60)
        self.assertEqual((decode.returncode, decode.stderr), (0, b""))

    def test_mpeg_ps_clock_reset_and_wrap_reach_the_last_picture(self):
        self.worker.encoders[FFMPEG] = "libx264"
        def clip(name, offset):
            path = self.root / name
            ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25", "-f", "lavfi", "-i", "sine=r=48000",
               "-t", "14", "-c:v", "mpeg2video", "-g", "12", "-c:a", "ac3",
               "-output_ts_offset", offset, "-f", "vob", path)
            return path

        second = clip("restart.vob", "0")
        reset = self.root / "joined.vob"
        reset.write_bytes(clip("offset.vob", "100").read_bytes() + second.read_bytes())
        repeated = self.root / "repeated.vob"
        repeated.write_bytes(second.read_bytes() * 2)
        wrap = clip("wrap.vob", "95439")
        for path, length, jump in ((reset, 28, True), (repeated, 28, True), (wrap, 14, False)):
            with self.subTest(path=path.name):
                def metadata(*args):
                    data = video.run_ffprobe(*args)
                    if path == wrap:  # This muxer's header can report the wrap correctly.
                        for stream in [data["format"], *data["streams"]]:
                            stream.pop("duration", None)
                    return data
                self.worker.probe = metadata
                for start in (0, (length // 2 + 5) // 6):
                    token = self.register(path)
                    movie = self.worker.sessions[token].movie
                    self.assertFalse(movie.duration_estimated)
                    self.assertAlmostEqual(movie.duration, length, delta=.04)
                    self.assertEqual(movie.timestamp_jump, jump)
                    self.assertGreaterEqual(movie.duration, length)
                    self.assertLess(movie.duration, length * 1.12)
                    for n in range(start, (length - 1) // 6 + 1):
                        ts = self.get(token, n)
                        stream = probe(ts, "-select_streams", "v", "-show_streams")["streams"][0]
                        self.assertAlmostEqual(float(stream["start_time"]), n * 6, delta=1/90000)
                    # Compare the decoded picture in the final tenth of a second.
                    def picture(file, t):
                        return ff("-i", file, "-ss", t, "-frames:v", 1, "-vf", "scale=48:32,format=gray",
                                  "-f", "rawvideo", "-")
                    expected = picture(second, 13.92)
                    actual = picture(ts, length - n * 6 - .08)
                    self.assertEqual((len(actual), len(expected)), (1536, 1536))
                    self.assertLess(sum(abs(a-b) for a,b in zip(actual, expected))/1536, 5)
                    with self.assertRaises(ApiError) as end:
                        self.get(token, video.segment_count(movie.duration))
                    self.assertEqual(end.exception.status, 416)
                    self.assertEqual(self.worker.sessions[token].failures, 0)

    def test_five_variable_rate_cells_match_continuous_playback(self):
        self.worker.encoders[FFMPEG] = "libx264"
        joined = self.root / "five cells.vob"
        with joined.open("wb") as output:
            for i, rate in enumerate(("2M", "5M", "3M", "8M", "4M")):
                part = self.root / f"part-{i}.vob"
                ff("-f", "lavfi", "-i", "testsrc2=s=160x120:r=25", "-f", "lavfi", "-i", "sine=r=48000",
                   "-t", "20", "-vf", f"hue=h={70*i},drawbox=w=40:h=120:color=white:t=fill:enable='lt(mod(t,3),1)'",
                   "-af", "volume='lt(mod(t,3),1)':eval=frame", "-c:a", "ac3", "-c:v", "mpeg2video",
                   "-g", "12", "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", "1M", "-f", "vob", part)
                with part.open("rb") as source:
                    shutil.copyfileobj(source, output)

        def pictures(ts, seek=()):
            return ff("-i", ts, *seek, "-vf", "scale=80:60,format=gray", "-f", "rawvideo", "-")

        def audio_markers(ts):
            pcm = array("h", ff("-i", ts, "-map", "0:a", "-ac", 1, "-ar", 8000, "-f", "s16le", "-"))
            start = float(probe(ts, "-select_streams", "a", "-show_entries", "stream=start_time")["streams"][0]["start_time"])
            # The first independently decoded AAC window needs overlap from the prior packet.
            return [round(start+i*.005, 5) for i in range(5, len(pcm)//40)
                    if (max(pcm[(i-1)*40:i*40]) > 500) != (max(pcm[i*40:(i+1)*40]) > 500)]

        wanted = (3, 8, 10, 16)  # Through a join, inside part 3, on a join, and at EOF.
        reference = {}
        with mock.patch.object(video, "_probe_timeline", wraps=video._probe_timeline) as scan:
            token = self.register(joined)
            movie = self.worker.sessions[token].movie
            self.assertFalse(movie.duration_estimated)
            self.assertEqual(movie.timeline.pieces, 5)
            self.assertAlmostEqual(movie.duration, 100, delta=.04 * 5)
            self.assertEqual(video.segment_count(movie.duration), 17)
            for n in range(17):
                ts = self.get(token, n)
                if n in wanted:
                    reference[n] = pictures(ts), audio_markers(ts)
            for n in wanted:
                with self.subTest(n=n):
                    self.assertIn("-start", video.command(movie, n, "libx264"))
                    ts = self.get(self.register(joined), n)
                    tracks = probe(ts, "-show_streams")["streams"]
                    self.assertAlmostEqual(float(tracks[0]["start_time"]), n * 6, delta=1/90000)
                    self.assertAlmostEqual(float(tracks[1]["start_time"]), n * 6, delta=1024/48000)
                    frames, markers = reference[n]
                    actual = pictures(ts)
                    self.assertEqual(len(actual), len(frames))
                    for pos in (0, len(frames)//9600*4800, len(frames)-4800):
                        error = sum(abs(a-b) for a,b in zip(actual[pos:pos+4800], frames[pos:pos+4800]))/4800
                        self.assertLess(error, 3, (n, pos))
                    observed = audio_markers(ts)
                    self.assertEqual(len(markers), len(observed), (markers, observed))
                    self.assertTrue(all(abs(a-b) <= .025 for a,b in zip(markers, observed)), (markers, observed))
                    if n == 16:
                        source = pictures(part, ("-ss", "19.96", "-frames:v", "1"))
                        self.assertEqual(len(source), 4800)
                        self.assertLess(sum(abs(a-b) for a,b in zip(actual[-4800:], source))/4800, 3)
            scan.assert_called_once()

    def test_wrapped_byte_seeks_match_continuous_playback_through_eof(self):
        joined = self.root / "wrapped cells.vob"
        part = self.root / "cell.vob"
        with joined.open("wb") as output:
            for i, offset in enumerate((100, 95439, 85, 95439)):
                ff("-f", "lavfi", "-i", "testsrc2=s=96x64:r=25", "-f", "lavfi", "-i", "sine=r=48000",
                   "-t", "20", "-vf", f"hue=h={i*65}", "-af", "volume='lt(mod(t,3),1)':eval=frame",
                   "-c:v", "mpeg2video", "-g", "10", "-c:a", "ac3", "-output_ts_offset", offset, "-f", "vob", part)
                output.write(part.read_bytes())
        self.worker.encoders[FFMPEG] = "libx264"
        suffix = self.root / "suffix.ts"
        launches = self.enterContext(mock.patch.object(self.worker, "launch", wraps=self.worker.launch))
        for start in (0, 1, 3, 4, 5, 6, 7, 8, 10, 11, 12):
            with self.subTest(start=start):
                token = self.register(joined)
                movie = self.worker.sessions[token].movie
                self.assertEqual(movie.timeline.pieces, 4)
                self.assertAlmostEqual(movie.duration, 80, delta=.04)
                launches.reset_mock()
                with suffix.open("wb") as output:
                    for n in range(start, video.segment_count(movie.duration)):
                        ts = self.get(token, n)
                        packets = probe(ts, "-show_entries", "packet=codec_type,pts_time")["packets"]
                        for kind in ("video", "audio"):
                            pts = [float(p["pts_time"]) for p in packets if p["codec_type"] == kind]
                            self.assertAlmostEqual(pts[0], n * 6, delta=.043)
                            self.assertLess(max(pts), min((n + 1) * 6, movie.duration) + .043)
                        output.write(ts.read_bytes())
                launches.assert_called_once()
                if start:
                    self.assertIn("-start", launches.call_args.args[0])
                frames = ff("-i", suffix, "-map", "0:v", "-vf", "scale=32:24,format=gray", "-f", "rawvideo", "-")
                pcm = array("h", ff("-i", suffix, "-map", "0:a", "-ac", 1, "-ar", 8000, "-f", "s16le", "-"))
                tone = [max(pcm[i:i+80]) > 500 for i in range(0, len(pcm)-79, 80)]
                if start == 0:
                    reference, sound = frames, tone
                    self.assertEqual(len(frames), 80 * 25 * 768)
                    continue
                expected = reference[start * 6 * 25 * 768:]
                self.assertEqual(len(frames), len(expected))
                for i in range(0, len(frames), 768):
                    error = sum(abs(a-b) for a, b in zip(frames[i:i+768], expected[i:i+768])) / 768
                    self.assertLess(error, 4, (start, i // 768))
                expected_tone = sound[start * 600:]
                self.assertLessEqual(abs(len(tone) - len(expected_tone)), 4)
                for i in range(4, min(len(tone), len(expected_tone)) - 4):
                    self.assertIn(tone[i], expected_tone[i-3:i+4], (start, i))

    def test_late_audio_stays_in_its_segment(self):
        path = self.root / "late audio.mkv"
        ff("-f", "lavfi", "-i", "testsrc2=s=96x64:r=25", "-itsoffset", "14", "-f", "lavfi",
           "-i", "sine=r=48000", "-t", "30", "-c:v", "mpeg2video", "-g", "10", "-c:a", "pcm_s16le", path)
        self.worker.encoders[FFMPEG] = "libx264"
        for start in (0, 2, 3, 4):
            token = self.register(path)
            for n in range(start, 5):
                with self.subTest(start=start, n=n):
                    ts = self.get(token, n)
                    packets = probe(ts, "-select_streams", "a", "-show_packets")["packets"]
                    times = [float(p["pts_time"]) for p in packets]
                    self.assertGreaterEqual(min(times), n * 6 - .043)
                    self.assertLess(max(times), (n + 1) * 6 + .043)
                    pcm = array("h", ff("-i", ts, "-map", "0:a", "-ac", 1, "-ar", 8000, "-f", "s16le", "-"))
                    onset = next((i / 8000 for i, sample in enumerate(pcm) if abs(sample) > 500), None)
                    if n < 2:
                        self.assertIsNone(onset)
                    else:
                        self.assertAlmostEqual(min(times) + onset, max(14, n * 6), delta=.06)

    def test_unusable_audio_burst_at_eof_plays_silent(self):
        path = self.root / "audio burst.vob"
        ff("-f", "lavfi", "-i", "testsrc2=s=96x64:r=25", "-itsoffset", "29.7", "-f", "lavfi",
           "-i", "sine=r=48000:d=0.3", "-t", "30", "-c:v", "mpeg2video", "-c:a", "ac3", "-f", "vob", path)
        packets = probe(path, "-select_streams", "a", "-show_packets")["packets"]
        self.assertTrue(8 <= len(packets) <= 12)
        self.assertGreater(float(packets[0]["pts_time"]), 29)
        self.worker.encoders[FFMPEG] = "libx264"

        def bad_parameters(*args):
            data = video.run_ffprobe(*args)
            audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
            if audio is None:
                audio = dict(codec_type="audio", index=1, id="0x80")
                data["streams"].append(audio)
            audio.update(channels=0, sample_rate="0")
            return data

        self.worker.probe = bad_parameters
        token = self.register(path)
        self.assertIsNone(self.worker.sessions[token].movie.audio)
        for n in range(5):
            ts = self.get(token, n)
            streams = probe(ts, "-show_entries", "stream=codec_type")["streams"]
            self.assertEqual(streams, [{"codec_type": "video"}])

    def test_cancel_packet_index_reaps_ffprobe(self):
        path = self.root / "cancel.vob"
        ff("-f", "lavfi", "-i", "testsrc2=s=96x64:r=25", "-t", "10", "-c:v", "mpeg2video", "-f", "vob", path)
        path.write_bytes(path.read_bytes() * 16)
        cancel = threading.Event()
        children = []
        launch = video._launch
        def capture(*args, **kwargs):
            child = launch(*args, **kwargs)
            children.append(child)
            return child
        active = []
        def interrupt(lines, frame):
            packet = next(lines)
            active.append(b"dts_time=" in packet and children[0].poll() is None)
            cancel.set()
            # Keep the real pipe open until cancellation terminates the writer.
            children[0].wait(timeout=3)
        with (mock.patch.object(video, "_launch", side_effect=capture),
              mock.patch.object(video, "_read_timeline", side_effect=interrupt),
              self.assertRaises(ConnectionAbortedError)):
            video._probe_timeline(FFPROBE, str(path), "0", .04, cancel)
        self.assertEqual(active, [True])
        self.assertNotIn(children[0].poll(), (None, 0))

    def test_preparation_reuses_the_stored_index_after_restart(self):
        clip = self.root / "index-cell.vob"
        ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25", "-t", "8",
           "-c:v", "mpeg2video", "-g", "12", "-f", "vob", clip)
        jump = self.root / "index-jump.vob"
        jump.write_bytes(clip.read_bytes() * 2)

        def prepare(worker):
            worker.encoders[FFMPEG] = "libx264"
            return worker.prepare(str(jump), jump.is_file, None, threading.Event())

        def restart():
            video._indexes.clear()
            video._detection_samples.clear()
            return video.ComputerVideo(self.cache, ffmpeg=lambda: FFMPEG)

        with (mock.patch.object(video, "_indexes", video.OrderedDict()),
              mock.patch.object(video, "_detection_samples", video.OrderedDict()),
              mock.patch.object(video, "_probe_timeline", wraps=video._probe_timeline) as scan):
            with self.assertLogs(video.__name__, level="WARNING") as log:
                first = prepare(self.worker)
                self.assertEqual(prepare(self.worker).timeline, first.timeline)
            self.assertEqual(len(log.output), 1)
            self.assertTrue(first.timestamp_jump)
            self.assertTrue(first.timeline.anchors)
            scan.assert_called_once()
            [saved] = self.worker.index_store.directory.glob("*.json")
            self.assertRegex(saved.name, r"^[0-9a-f]{64}\.json$")
            self.assertNotIn(jump.name, saved.read_text(encoding="utf-8"))

            with self.assertLogs(video.__name__, level="WARNING") as log:
                restored = prepare(restart())
            self.assertEqual(restored.timeline, first.timeline)
            self.assertEqual(len(log.output), 1)
            self.assertRegex(log.output[0], r"verdict=indexed reason=stored .+ probe_ms=\d+$")
            scan.assert_called_once()

            stamp = jump.stat().st_mtime_ns + 1_000_000_000
            os.utime(jump, ns=(stamp, stamp))
            changed_worker = restart()
            self.assertEqual(prepare(changed_worker).timeline, first.timeline)
            self.assertEqual(scan.call_count, 2)
            changed_key = (video._index_key(jump), first.video)
            changed = changed_worker.index_store._path(changed_key)
            self.assertNotEqual(changed, saved)
            self.assertEqual(list(changed_worker.index_store.directory.glob("*.json")), [changed])
            self.assertEqual(json.loads(changed.read_text(encoding="utf-8"))["mtime_ns"], stamp)

            for bad in ("invalid JSON", '{"version": 0, "size": 0, "mtime_ns": 0, "track": 0}'):
                with self.subTest(bad=bad):
                    changed.write_text(bad, encoding="utf-8")
                    attempts = scan.call_count
                    self.assertEqual(prepare(restart()).timeline, first.timeline)
                    self.assertEqual(scan.call_count, attempts + 1)
                    self.assertEqual(json.loads(changed.read_text(encoding="utf-8"))["mtime_ns"], stamp)

    def test_two_low_rate_cells_play_through_the_second_cell(self):
        joined = self.root / "two-cells.vob"
        with joined.open("wb") as output:
            for color in ("red", "blue"):
                part = self.root / (color + "-30.vob")
                ff("-f", "lavfi", "-i", f"color={color}:s=160x120:r=25", "-t", "30",
                   "-c:v", "mpeg2video", "-g", "12", "-b:v", "2M", "-minrate", "2M",
                   "-maxrate", "2M", "-bufsize", "500k", "-f", "vob", part)
                with part.open("rb") as source:
                    shutil.copyfileobj(source, output)
        data = probe(joined, "-show_format")
        self.assertAlmostEqual(float(data["format"]["duration"]), 30, delta=.1)
        token = self.register(joined)
        movie = self.worker.sessions[token].movie
        self.assertTrue(movie.timestamp_jump)
        self.assertFalse(movie.duration_estimated)
        self.assertAlmostEqual(movie.duration, 60, delta=.04)
        for n in range(10):
            last = self.get(token, n)
        rgb = ff("-i", last, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-")
        self.assertGreaterEqual(len(rgb), 3 * 145)
        self.assertGreater(rgb[-1], 200)
        with self.assertRaises(ApiError) as end:
            self.get(token, 10)
        self.assertEqual(end.exception.status, 416)

    def test_low_rate_intro_keeps_continuous_timeline(self):
        path = self.root / "intro.vob"
        ff("-f", "lavfi", "-i", "color=black:s=320x240:r=25:d=20", "-f", "lavfi", "-i",
           "testsrc2=s=320x240:r=25:d=60", "-filter_complex", "concat=n=2:v=1:a=0",
           "-c:v", "mpeg2video", "-g", "12", "-q:v", "3", "-f", "vob", path)
        data = probe(path, "-show_format", "-show_streams")
        with mock.patch.object(video, "_packet_sample", wraps=video._packet_sample) as sample:
            movie = video.movie_info(FFMPEG, str(path), data, None)
        self.assertEqual(sample.call_count, 5)
        self.assertAlmostEqual(movie.duration, 80, delta=.1)
        self.assertFalse(movie.duration_estimated or movie.timestamp_jump)
        self.assertIn("-ss", video.command(movie, 8, "libx264"))

    def test_genuine_high_rate_program_stream_is_indexed_and_uses_timestamp_seek(self):
        path = self.root / "twenty.mpg"
        ff("-f", "lavfi", "-i", "testsrc2=s=160x120:r=25", "-t", "8", "-c:v", "mpeg2video",
           "-b:v", "20M", "-minrate", "20M", "-maxrate", "20M", "-bufsize", "2M", "-f", "vob", path)
        data = probe(path, "-show_streams", "-show_format")
        reported = float(data["streams"][0]["duration"])
        self.assertAlmostEqual(path.stat().st_size * 8 / reported / 1e6, 20, delta=1)
        movie = video.movie_info(FFMPEG, str(path), data, None)
        self.assertEqual(movie.timeline.pieces, 1)
        self.assertAlmostEqual(movie.duration, reported, delta=.04)
        self.assertFalse(movie.duration_estimated or movie.timestamp_jump)

    def test_dvd_with_final_reset_frame_matches_moving_source_on_fresh_starts(self):
        body, single, dvd = (self.root / name for name in ("body.vob", "single.vob", "reset-frame.vob"))
        source = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30000/1001"]
        picture = ["-c:v", "mpeg2video", "-flags", "+ildct+ilme", "-top", "1", "-g", "15", "-q:v", "4"]
        ff(*source, "-f", "lavfi", "-i", "sine=r=48000", "-t", "65.2", *picture, "-c:a", "pcm_dvd",
           "-f", "vob", body)
        start = probe(body, "-select_streams", "v", "-show_entries", "stream=start_time")["streams"][0]["start_time"]
        ff(*source, "-frames:v", 1, *picture, "-output_ts_offset", start, "-f", "vob", single)
        # Put standard MPEG padding packets before the final audio packs.
        # FFprobe's tail window then sees the real audio end and the reset video PTS.
        packs = body.read_bytes()
        audio_tail = (packs.rindex(bytes.fromhex("000001e0")) // 2048 + 1) * 2048
        padding = (bytes.fromhex("000001be07fa") + bytes(2042)) * 256
        dvd.write_bytes(packs[:audio_tail] + padding + packs[audio_tail:] + single.read_bytes())
        tracks = probe(dvd, "-show_streams")["streams"]
        self.assertAlmostEqual(float(tracks[0]["duration"]), .033367, places=5)
        self.assertGreater(float(tracks[1]["duration"]), 65)
        last = video.segment_count(float(tracks[1]["duration"])) - 1

        def frame(path, t, deinterlace=False):
            filters = ("yadif=mode=send_frame," if deinterlace else "") + "scale=80:60,format=gray"
            raw = ff("-i", path, "-ss", t, "-map", "0:v", "-vf", filters, "-frames:v", 1, "-f", "rawvideo", "-")
            self.assertEqual(len(raw), 4800)
            return raw

        def difference(left, right):
            return sum(abs(a - b) for a, b in zip(left, right)) / len(left)

        for n in (0, 5, last):
            with self.subTest(n=n):
                token = self.register(dvd)
                ts = self.get(token, n)
                movie = self.worker.sessions[token].movie
                self.assertAlmostEqual(movie.duration, 65.2, delta=1 / float(movie.fps))
                if movie.picture_check is not None:
                    self.assertEqual(movie.picture_check.offsets[n * 6], (movie.duration, False))
                streams = probe(ts, "-show_streams")["streams"]
                self.assertEqual([s["codec_name"] for s in streams], ["h264", "aac"])
                for stream in streams:
                    self.assertAlmostEqual(float(stream["start_time"]), n * 6, delta=.034)
                images = []
                for t in (1, 3):
                    actual = frame(ts, t)
                    self.assertLess(difference(actual, frame(body, n * 6 + t, True)), 4)
                    images.append(actual)
                self.assertGreater(difference(*images), 8)

    def test_still_dvd_direct_start_with_each_available_encoder(self):
        path = self.root / "bars.vob"
        ff("-f", "lavfi", "-i", "smptebars=size=320x240:rate=30000/1001:duration=0.14",
           "-f", "lavfi", "-i", "sine=r=48000:duration=65.2347", "-c:v", "mpeg2video",
           "-flags", "+ildct+ilme", "-top", "1", "-c:a", "pcm_dvd", "-f", "vob", path)
        last_bar = self.root / "last-bar.vob"
        start = probe(path, "-select_streams", "v", "-show_entries", "stream=start_time")["streams"][0]["start_time"]
        ff("-f", "lavfi", "-i", "smptebars=size=320x240:rate=30000/1001", "-frames:v", 1,
           "-c:v", "mpeg2video", "-flags", "+ildct+ilme", "-top", "1", "-output_ts_offset", start, "-f", "vob",
           last_bar)
        with path.open("ab") as output:
            output.write(last_bar.read_bytes())
        data = probe(path, "-show_format", "-show_streams")
        self.assertAlmostEqual(float(data["streams"][0]["duration"]), .033367, places=5)
        expected = ff("-i", path, "-frames:v", 1, "-vf", "scale=64:48,format=gray", "-f", "rawvideo", "-")
        for encoder in ("libx264", *video.HARDWARE):
            if not video.probe_encoder(FFMPEG, encoder, lambda: False):
                self.assertNotEqual(encoder, "libx264")
                continue
            with self.subTest(encoder=encoder), tempfile.TemporaryDirectory() as work:
                movie = video.movie_info(FFMPEG, str(path), data, None)
                args = video.command(movie, 5, encoder)
                self.assertEqual(args[args.index("-t") + 1], "1.033367")
                self.assertEqual(args.count("-i"), 2)
                subprocess.run(args, cwd=work, check=True, timeout=45, capture_output=True)
                segment = Path(work) / "5.ts"
                v, a = probe(segment, "-show_streams")["streams"]
                for stream in (v, a):
                    self.assertAlmostEqual(float(stream["start_time"]), 30, delta=.034)
                    self.assertAlmostEqual(float(stream["duration"]), 6, delta=.05)
                actual = ff("-i", segment, "-ss", 5, "-frames:v", 1, "-vf", "scale=64:48,format=gray",
                            "-f", "rawvideo", "-")
                self.assertEqual((len(expected), len(actual)), (3072, 3072))
                self.assertLess(sum(abs(x-y) for x,y in zip(actual, expected)) / 3072, 4)
                sound = array("h", ff("-i", segment, "-map", "0:a", "-ac", 1, "-f", "s16le", "-"))
                self.assertGreater(max(sound), 500)

    def test_music_dvd_last_picture_and_pcm_on_direct_starts(self):
        self.worker.encoders[FFMPEG] = "libx264"
        path = self.root / "music.vob"
        ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25:duration=1",
           "-f", "lavfi", "-i", "sine=r=48000:duration=60", "-c:v", "mpeg2video",
           "-c:a", "pcm_dvd", "-f", "vob", path)
        frames = ff("-i", path, "-map", "0:v", "-vf", "scale=48:32,format=gray", "-f", "rawvideo", "-")
        expected = frames[-1536:]
        for known in (True, False):
            def metadata(*args):
                data = video.run_ffprobe(*args)
                picture = next(s for s in data["streams"] if s["codec_type"] == "video")
                if known:
                    picture["duration"] = "1"
                else:
                    picture.pop("duration", None)
                return data
            self.worker.probe = metadata
            for n in (0, 3, 9):
                with self.subTest(known=known, n=n):
                    ts = self.get(self.register(path), n)
                    v, a = probe(ts, "-show_streams")["streams"]
                    self.assertAlmostEqual(float(v["start_time"]), n * 6, delta=1/90000)
                    self.assertAlmostEqual(float(a["start_time"]), n * 6, delta=1024/48000)
                    self.assertAlmostEqual(float(a["duration"]), 6, delta=.06)
                    self.assertAlmostEqual(float(v["duration"]), 6, delta=.06)
                    for t in ((1.5, 5.9) if n == 0 else (0, 5.9)):
                        image = ff("-i", ts, "-ss", t, "-frames:v", 1, "-vf", "scale=48:32,format=gray",
                                   "-f", "rawvideo", "-")
                        self.assertEqual(len(image), 1536)
                        self.assertLess(sum(abs(a-b) for a,b in zip(image, expected))/1536, 4)
                    pcm = array("h", ff("-i", ts, "-map", "0:a", "-ac", 1, "-ar", 8000, "-f", "s16le", "-"))
                    self.assertGreater(len(pcm), 47000)
                    for second in range(6):
                        self.assertGreater(max(pcm[second*8000:second*8000+4000]), 500)

    def test_fractional_fps_grid_is_identical_after_seek(self):
        for rate in ("24000/1001", "30000/1001", "60000/1001"):
            with self.subTest(rate=rate):
                path = self.root / "ntsc.mkv"
                ff("-f", "lavfi", "-i", f"testsrc2=size=160x96:rate={rate}", "-f", "lavfi", "-i", "sine",
                   "-t", "19", "-c:v", "mpeg4", "-c:a", "aac", path)
                token = self.register(path)
                for n in range(4):
                    streams = probe(self.get(token, n), "-show_streams")["streams"]
                    self.assertAlmostEqual(float(streams[0]["start_time"]), n*6, delta=1/90000)
                    self.assertAlmostEqual(float(streams[1]["start_time"]), n*6, delta=1024/48000+1/90000)
                second = self.register(path)
                streams = probe(self.get(second, 2), "-show_streams")["streams"]
                self.assertAlmostEqual(float(streams[0]["start_time"]), 12, delta=1/90000)

    def test_restart_pictures(self):
        for kind in ("open-gop", "vfr", "offset-ts"):
            with self.subTest(kind=kind):
                path = self.root / (kind + (".ts" if kind == "offset-ts" else ".mp4"))
                options = (["-vf", "select='if(lt(mod(t,2),1),1,not(mod(n,2)))'", "-fps_mode", "vfr"]
                           if kind == "vfr" else ["-output_ts_offset", "700"] if kind == "offset-ts" else [])
                ff("-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30", "-t", "26", "-c:v", "libx264",
                   "-g", "300", "-bf", "3", "-x264-params", "open-gop=1:scenecut=0", *options, path)
                def pictures(file, start=None):
                    select = ["-ss", str(start), "-frames:v", "1"] if start is not None else []
                    frames = ff("-i", file, *select, "-vf", "scale=80:48,format=gray", "-fps_mode", "passthrough",
                                "-f", "rawvideo", "-")
                    self.assertGreaterEqual(len(frames), 3840)
                    return frames[:3840], frames[-3840:]
                source, _ = pictures(path, 18)
                token = self.register(path)
                self.get(token, 0)
                for i in (1, 2):
                    self.get(token, i)
                continuous = pictures(self.get(token, 3))
                direct = pictures(self.get(self.register(path), 3))
                seeking = self.register(path)
                self.get(seeking, 4)
                restarted = pictures(self.get(seeking, 3))
                for label, a, b in (("source", source, direct[0]), ("first", continuous[0], restarted[0]),
                                    ("last", continuous[1], restarted[1])):
                    error = sum(abs(x-y) for x,y in zip(a,b))/len(a)
                    self.assertLess(error, 3, (kind, label, error))
                    if os.environ.get("WORLDMEDIA_VIDEO_BENCH") == "1":
                        print(f"{kind} {label} MAE {error:.3f}")

    def test_real_worker_stops_and_reaps_its_children(self):
        source = self.root / "long.mkv"
        ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=6", "-t", "420", "-c:v", "mpeg4", source)
        children = []
        def launch(cmd, cwd):
            self.assertTrue(all(p.poll() is not None for p in children))
            process = video._launch(cmd, cwd)
            children.append(process)
            return process
        self.worker.launch = launch
        self.worker.encoders = {FFMPEG: "libx264"}
        self.worker.clock = lambda: now
        now = 0
        first = self.register(source)
        self.get(first, 0)
        eventually(lambda: self.worker.run is None)
        self.assertIsNotNone(children[-1].poll())
        self.assertLessEqual(max(self.worker.sessions[first].sizes), 20)
        self.get(first, 30)
        now = 61
        eventually(lambda: self.worker.run is None)
        self.get(first, 40)
        second = self.register(source)
        self.get(first, 40)
        self.worker.discard(first)
        self.assertFalse((self.cache / first).exists())
        with self.assertRaises(ApiError) as error:
            self.get(first, 40)
        self.assertEqual(error.exception.status, 410)
        self.get(second, 0)
        self.assertTrue(self.worker.shutdown(3))
        self.assertTrue(all(p.poll() is not None for p in children))
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_rotated_hdr_output_is_portrait_bt709(self):
        if not video._hdr_filters(FFMPEG):
            self.skipTest("FFmpeg does not include the HDR filters.")
        original = self.root / "landscape.mp4"
        path = self.root / "rotated.mp4"
        for transfer in ("smpte2084", "arib-std-b67"):
            ff("-f", "lavfi", "-i", "testsrc2=size=320x192:rate=25", "-t", "1", "-c:v", "libx264",
               "-pix_fmt", "yuv420p10le", "-color_trc", transfer, "-colorspace", "bt2020nc",
               "-color_primaries", "bt2020", original)
            ff("-i", original, "-c", "copy", "-metadata:s:v:0", "rotate=90", path)
            stream = probe(self.get(self.register(path), 0), "-show_streams")["streams"][0]
            self.assertEqual((stream["width"], stream["height"]), (192, 320))
            self.assertEqual((stream["color_transfer"], stream["color_space"], stream["color_primaries"]),
                             ("bt709", "bt709", "bt709"))

    def test_real_writer_pauses_before_exceeding_folder_limit(self):
        path = self.root / "large-segment.mp4"
        ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "7", "-c:v", "libx264", path)
        self.worker.limit = 8192
        token = self.register(path)
        with mock.patch.object(self.worker, "launch", wraps=video._launch) as start:
            for _ in range(2):
                with self.assertRaises(ApiError) as pending:
                    self.get(token, 0)
                self.assertEqual(pending.exception.status, 503)
            self.assertEqual(start.call_count, 1)
            self.assertIsNone(self.worker.run)
            self.assertGreater(self.worker.sessions[token].blocked_size, self.worker.limit)
            self.assertFalse(any((self.cache / token).iterdir()))

    def test_real_competing_waiter_and_early_eof(self):
        path = self.root / "short-input.mp4"
        ff("-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30", "-t", "2", "-c:v", "libx264", path)
        first = self.register(path)
        def slow_launch(args, cwd):
            args.insert(args.index("-i"), "-re")
            return video._launch(args, cwd)
        self.worker.launch = slow_launch
        with ThreadPoolExecutor(1) as pool:
            waiting = pool.submit(self.get, first, 0)
            eventually(lambda: self.worker.run is not None)
            child = self.worker.run.process
            second = self.register(path)
            self.worker.discard(first)
            with self.assertRaises(ApiError) as ended:
                waiting.result(3)
            self.assertEqual(ended.exception.status, 410)
            self.assertIsNotNone(child.poll())
        self.worker.launch = video._launch
        # Model a lying container with no useful stream end timestamps.
        movie = self.worker.sessions[second].movie
        movie.duration = 40
        for n in (5, 5, 6):
            with self.assertRaises(ApiError) as end:
                self.get(second, n)
            self.assertEqual(end.exception.status, 416)
        self.assertEqual(self.worker.sessions[second].failures, 0)
        self.get(second, 0)
        eventually(lambda: self.worker.run is None)
        end = float(probe(self.cache / second / "0.ts", "-show_format")["format"]["duration"])
        self.assertLessEqual(end, 4.001)
        with self.assertRaises(ApiError) as gone:
            self.get(second, 1)
        self.assertEqual(gone.exception.status, 416)

    def test_exact_boundary_with_audio_encoder_padding(self):
        path = self.root / "boundary.mkv"
        ff("-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30", "-f", "lavfi", "-i", "sine",
           "-t", "12", "-c:v", "mpeg4", "-c:a", "mp2", path)
        for direct in (False, True):
            token = self.register(path)
            duration = self.worker.sessions[token].movie.duration
            last = video.segment_count(duration) - 1
            if not direct:
                for i in range(last):
                    self.get(token, i)
            stream = probe(self.get(token, last), "-select_streams", "v:0", "-show_streams")["streams"][0]
            self.assertAlmostEqual(float(stream["start_time"]), 6*last, delta=1/30)

    def test_other_codecs_stereo_and_silent_video(self):
        for ext, codec, audio in [("avi", "mpeg4", "libmp3lame"), ("wmv", "wmv2", "wmav2"), ("mkv", "libx265", None)]:
            with self.subTest(ext=ext):
                path = self.root / ("short." + ext)
                sound = ["-f", "lavfi", "-i", "sine", "-ac", "2", "-c:a", audio] if audio else []
                ff("-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", *sound, "-t", "1", "-c:v", codec, path)
                token = self.register(path)
                streams = probe(self.get(token, 0), "-show_streams")["streams"]
                self.assertEqual(streams[0]["codec_name"], "h264")
                if audio:
                    self.assertEqual((streams[1]["codec_name"], streams[1]["channels"]), ("aac", 2))
                else:
                    self.assertEqual(len(streams), 1)

    @bench
    def test_http_play_playlist_seek_errors_and_removal(self):
        self.make_dvd()
        import worldmedia_server as server
        from worldmedia_computer import ComputerFolders
        from worldmedia_computer_library import _file_id
        folders = ComputerFolders(self.cache.parent / "folders.json", ffprobe=lambda _: FFPROBE)
        saved = folders.add(str(self.root))
        identity = _file_id(str(self.dvd))
        info = self.dvd.stat()
        entry = dict(id=identity, folder=saved["id"], rel=self.dvd.name, ext="vob",
                     size=info.st_size, mtime=info.st_mtime_ns, kind="video", probed=False)
        folders.library.load()
        folders.library._items[identity] = entry
        self.enterContext(mock.patch.multiple(server, COMPUTER_MEDIA=self.media, COMPUTER_FOLDERS=folders))
        httpd = server.ThreadingServer(("127.0.0.1", 0), server.WorldMediaHandler)
        self.addCleanup(httpd.server_close)
        thread = threading.Thread(target=httpd.serve_forever)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(httpd.shutdown)
        headers = {"Origin": f"http://127.0.0.1:{httpd.server_port}", "Content-Type": "application/json",
                   "X-WorldMedia-Token": server.SESSION_TOKEN}
        def request(url, body=None):
            with closing(http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=40)) as connection:
                connection.request("POST" if body else "GET", url, json.dumps(body) if body else None, headers)
                response = connection.getresponse()
                return response.status, response.read()
        route = "/api/v1/computer/play"
        for payload, status, code in [({"audio": -1}, 400, "INVALID_COMPUTER_PLAY"),
                                      ({"audio": 99}, 400, "INVALID_COMPUTER_AUDIO")]:
            result, body = request(route, {"id": identity, **payload})
            self.assertEqual((result, json.loads(body)["error"]["code"]), (status, code))
        with mock.patch.object(self.worker, "ffmpeg", return_value=None):
            status, body = request(route, {"id": identity})
            self.assertEqual((status, json.loads(body)["error"]["code"]), (503, "COMPUTER_CONVERT_FFMPEG"))
        launches = []
        def launch(args, cwd):
            launches.append(args)
            return video._launch(args, cwd)
        self.worker.launch = launch
        start = time.monotonic()
        status, body = request(route, {"id": identity, "audio": 0})
        self.assertEqual(status, 200, body)
        answer = json.loads(body)["data"]
        self.assertTrue(answer["hls"] and answer["converted"] and answer["entry"]["probed"])
        url = answer["url"]
        base = url.rsplit("/", 1)[0]
        self.assertEqual(request(url), (200, video.playlist(answer["duration"])))
        self.assertEqual(request(base + "/seg/0.ts")[0], 200)
        startup = time.monotonic()-start
        start = time.monotonic()
        self.assertEqual(request(base + "/seg/5.ts")[0], 200)
        seek = time.monotonic()-start
        self.assertEqual([args[args.index("-start_number")+1] for args in launches], ["0", "5"])
        print(f"HTTP MPEG-2 ({self.worker.encoder}): play to segment 0 {startup:.3f}s; seek to segment 5 {seek:.3f}s")
        print("Seek command:", subprocess.list2cmdline(launches[-1]))
        self.assertEqual(request(base + "/seg/100.ts")[0], 416)
        self.assertEqual(request(url.replace("/hls/", "/media/").rsplit("/", 1)[0])[0], 404)
        # Both routes use the same sliding token pool. The direct MP4 still
        # gets a byte-range URL until the caller explicitly requests conversion.
        native = self.root / "native.mp4"
        ff("-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-t", "1", "-c:v", "libx264", native)
        native_id = _file_id(str(native))
        st = native.stat()
        folders.library._items[native_id] = {**entry, "id": native_id, "rel": native.name, "ext": "mp4",
                                              "size": st.st_size, "mtime": st.st_mtime_ns}
        native_data = json.loads(request(route, {"id": native_id})[1])["data"]
        self.assertTrue(native_data["url"].startswith("/api/v1/computer/media/"))
        forced = json.loads(request(route, {"id": native_id, "convert": True})[1])["data"]
        self.assertTrue(forced["hls"])
        now = time.monotonic()
        self.media._clock = self.worker.clock = lambda: now
        self.assertEqual(request(url)[0], 200)
        url = forced["url"]
        now += TOKEN_TTL - 2
        self.assertEqual(request(url)[0], 200)
        now += 3
        self.assertEqual(request(forced["url"])[0], 200)
        self.assertEqual(request(url)[0], 200)
        for delta in (-20, 20):
            folders.library._items[identity]["duration"] = answer["duration"] + delta
            fresh = json.loads(request(route, {"id": identity})[1])["data"]
            self.assertEqual(fresh["duration"], answer["duration"])
            self.assertEqual(folders.library.entry(identity)["duration"], fresh["duration"])
            url = fresh["url"]
            self.assertEqual(request(url.rsplit("/", 1)[0] + "/seg/999.ts")[0], 416)
        self.assertEqual(request("/api/v1/computer/folders/remove", {"id": saved["id"]})[0], 200)
        self.assertEqual(request(url)[0], 410)
        self.assertEqual(list(self.cache.iterdir()), [])

    @bench
    def test_encoder_speeds(self):
        self.make_dvd()
        hd = self.root / "1080.mkv"
        ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine",
           "-t", "12", "-c:v", "mpeg2video", "-q:v", "5", "-c:a", "mp2", hd)
        supported = [e for e in video.HARDWARE if video.probe_encoder(FFMPEG, e, lambda: False)]
        print("Working hardware encoders:", supported)
        for source in (self.dvd, hd):
            movie = self.worker.prepare(str(source), source.is_file, None, threading.Event())
            for encoder in ["libx264", *supported]:
                with self.subTest(source=source.name, encoder=encoder):
                    with tempfile.TemporaryDirectory() as work:
                        args = video.command(movie, 0, encoder)
                        start = time.monotonic()
                        subprocess.run(args, check=True, timeout=90, cwd=work)
                        last = Path(work) / f"{video.segment_count(movie.duration)-1}.ts"
                        self.assertGreater(last.stat().st_size, 188, "Every advertised segment must exist")
                        self.assertTrue((Path(work)/"0.ts").is_file())
                        print(f"{source.name} {encoder}: {movie.duration/(time.monotonic()-start):.2f}x")
