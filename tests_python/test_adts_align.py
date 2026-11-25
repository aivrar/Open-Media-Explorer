"""A live AAC stream starts at its first whole frame (worldmedia_icy.AdtsAligner).

An old Shoutcast server starts a new listener in the middle of a frame; when
the partial frame holds bytes that look like a frame header, a decoder that
starts there fails (seen with Radio Caprice - Trip Hop: bytes ff f9 03 07 44
bytes before the first real frame).
"""
from __future__ import annotations

import http.client
import random
import time
import unittest
from types import SimpleNamespace

import tests_python.test_icy_metadata as icy_tests
import worldmedia_server
from worldmedia_icy import MAX_ALIGN_BYTES, MAX_ALIGN_SECONDS, AdtsAligner
from worldmedia_media import MediaRegistration


def adts_frame(length: int, rng: random.Random) -> bytes:
    """One ADTS frame: MPEG-4 AAC LC, 44.1 kHz, stereo, no CRC, `length` bytes in all."""
    header = bytes([
        0xFF, 0xF1, (1 << 6) | (4 << 2) | 0, (2 << 6) | ((length >> 11) & 0x03),
        (length >> 3) & 0xFF, ((length & 0x07) << 5) | 0x1F, 0xFC,
    ])
    return header + rng.randbytes(length - 7)


def frame_lengths(count: int, seed: int = 3) -> list[int]:
    rng = random.Random(seed)
    return [rng.randint(600, 1100) for _ in range(count)]


def frames(count: int, seed: int = 3) -> bytes:
    rng = random.Random(seed + 1000)
    return b"".join(adts_frame(length, rng) for length in frame_lengths(count, seed))


# The end of a frame, holding a false header (the bytes seen at the station).
FALSE_START = bytes.fromhex("59a61c3848af0693026921") + bytes.fromhex("fff903070a7a05e27bb435622d4029dfedd7b8be9f")
SOUND_FRAMES = frame_lengths(60)
SOUND = frames(60)
STREAM = FALSE_START + SOUND


def run(aligner: AdtsAligner, data: bytes, size: int) -> bytes:
    out = b"".join(aligner.feed(data[i:i + size]) for i in range(0, len(data), size))
    return out + aligner.finish()


class AdtsAlignerTests(unittest.TestCase):
    def test_the_stream_starts_at_the_first_whole_frame_whatever_the_chunks(self) -> None:
        for size in (1, 7, 100, 999, 4096, len(STREAM)):
            with self.subTest(size=size):
                self.assertEqual(run(AdtsAligner(), STREAM, size), SOUND)

    def test_after_the_start_everything_passes_unchanged(self) -> None:
        aligner = AdtsAligner()
        self.assertEqual(aligner.feed(STREAM), SOUND)
        for chunk in (b"\xff\xf9\x03", b"anything", b""):
            self.assertIs(aligner.feed(chunk), chunk)
        self.assertEqual(aligner.finish(), b"")

    def test_a_stream_that_starts_on_a_frame_is_unchanged(self) -> None:
        self.assertEqual(run(AdtsAligner(), SOUND, 500), SOUND)

    def test_without_two_matching_headers_nothing_is_dropped(self) -> None:
        noise = bytes(b if b != 0xFF else 0x00 for b in random.Random(5).randbytes(5000)) + FALSE_START
        # The stream ends before any start is found: all of it, unchanged.
        self.assertEqual(run(AdtsAligner(), noise, 300), noise)
        # Past the limit: all of it, unchanged, and the rest as it comes.
        long_noise = noise * (MAX_ALIGN_BYTES // len(noise) + 2)
        aligner = AdtsAligner()
        out = b"".join(aligner.feed(long_noise[i:i + 4096]) for i in range(0, len(long_noise), 4096))
        self.assertEqual(out + aligner.finish(), long_noise)
        # A header whose next header has other fixed fields is no start.
        other = bytearray(frames(1, seed=9))
        other[2] = (1 << 6) | (3 << 2)  # 48 kHz instead of 44.1 kHz
        mixed = bytes(other) + SOUND
        self.assertEqual(run(AdtsAligner(), mixed, 256), SOUND)

    def test_a_slow_stream_is_held_at_most_the_time_limit(self) -> None:
        # 32 kbps: 4 KB a second, with no frame found. Held bytes are passed
        # on unchanged once MAX_ALIGN_SECONDS have gone by since the first.
        self.assertLessEqual(MAX_ALIGN_SECONDS, 2.0)
        now = [100.0]
        aligner = AdtsAligner(clock=lambda: now[0])
        noise = bytes(b if b != 0xFF else 0x00 for b in random.Random(6).randbytes(20_000))
        out = b""
        for index in range(0, len(noise), 400):  # 400 bytes every 0.1 s
            out += aligner.feed(noise[index:index + 400])
            if out:
                break
            now[0] += 0.1
        self.assertEqual(out, noise[:len(out)])
        self.assertGreaterEqual(now[0] - 100.0, MAX_ALIGN_SECONDS - 0.1)
        self.assertLessEqual(now[0] - 100.0, MAX_ALIGN_SECONDS + 0.1)
        self.assertLess(len(out), MAX_ALIGN_BYTES)
        # From then on everything passes as it comes.
        rest = noise[len(out):]
        self.assertIs(aligner.feed(rest), rest)
        # A confirmed start in the first chunk is passed on with that chunk.
        partial = FALSE_START[:11] + SOUND
        self.assertEqual(AdtsAligner(clock=lambda: 0.0).feed(partial[:5000]), partial[11:5000])

    def test_a_false_header_waiting_for_its_claimed_length_does_not_hold_the_real_start(self) -> None:
        # The false header claims 6227 bytes. At 32 kbps (4 KB a second, 200
        # bytes every 0.05 s) the real start, three frames later, is released
        # long before those 6227 bytes or the time limit.
        now = [0.0]
        aligner = AdtsAligner(clock=lambda: now[0])
        out, fed = b"", 0
        for index in range(0, len(STREAM), 200):
            out += aligner.feed(STREAM[index:index + 200])
            fed = index + 200
            if out:
                break
            now[0] += 0.05
        three = sum(SOUND_FRAMES[:3])
        self.assertTrue(SOUND.startswith(out))
        self.assertLessEqual(fed, len(FALSE_START) + three + 7 + 200)
        self.assertLess(now[0], 0.5 * MAX_ALIGN_SECONDS)
        self.assertEqual(out + run(aligner, STREAM[fed:], 200), SOUND)

    def test_a_start_needs_three_frames_in_a_row_that_carry_sound(self) -> None:
        rng = random.Random(11)
        quiet = bytes(b if b != 0xFF else 0x00 for b in rng.randbytes(300))
        # Two alike frames, then junk: a header and one match is not enough.
        pair = adts_frame(120, rng) + adts_frame(200, rng)[:7] + quiet
        self.assertEqual(run(AdtsAligner(), pair + SOUND, 64), SOUND)
        # Headers with nothing after them (length 7) are no frames.
        empty = adts_frame(7, rng) * 6
        self.assertEqual(run(AdtsAligner(), empty + SOUND, 64), SOUND)
        # The first frame alone, with its two followers not yet here: held.
        aligner = AdtsAligner(clock=lambda: 0.0)
        self.assertEqual(aligner.feed(SOUND[:sum(SOUND_FRAMES[:2]) + 6]), b"")
        self.assertEqual(aligner.feed(SOUND[sum(SOUND_FRAMES[:2]) + 6:]), SOUND)


def registration(**changes) -> MediaRegistration:
    values = dict(
        token="root", item_id="playlist:1", url="http://example.invalid/", delivery="live", media_type="audio",
        headers={}, expires_at=0.0, root_token="root",
    )
    values.update(changes)
    return MediaRegistration(**values)


def response(status: int = 200, **headers) -> SimpleNamespace:
    named = {"Content-Type": "audio/aacp", **{k.replace("_", "-"): v for k, v in headers.items()}}
    return SimpleNamespace(status=status, getheader=lambda name, default=None: named.get(name, default))


class WhenToAlignTests(unittest.TestCase):
    def aligner(self, reg=None, method="GET", resp=None, **options):
        return worldmedia_server.relay_frame_aligner(reg or registration(), method, resp or response(), **options)

    def test_only_the_start_of_a_live_aac_stream_the_player_opens(self) -> None:
        self.assertIsInstance(self.aligner(dash=False), AdtsAligner)
        self.assertIsInstance(self.aligner(dash=False, range_value="bytes=0-"), AdtsAligner)
        for content_type in ("audio/aac", "audio/x-aac", "AUDIO/AACP; charset=x"):
            self.assertIsInstance(self.aligner(dash=False, resp=response(Content_Type=content_type)), AdtsAligner)
        refused = {
            "HEAD": dict(method="HEAD", dash=False),
            "a later range": dict(dash=False, range_value="bytes=100-"),
            "a DASH template": dict(dash=True),
            "MP3": dict(dash=False, resp=response(Content_Type="audio/mpeg")),
            "a file with a length": dict(dash=False, resp=response(Content_Length="1000")),
            "a range reply": dict(dash=False, resp=response(206, Content_Range="bytes 0-9/10")),
            "gzip": dict(dash=False, resp=response(Content_Encoding="gzip")),
            "an error": dict(dash=False, resp=response(404)),
            "on demand": dict(dash=False, reg=registration(delivery="on-demand")),
            "a child": dict(dash=False, reg=registration(token="child")),
            "a recording": dict(dash=False, reg=registration(capture=True)),
            "video": dict(dash=False, reg=registration(media_type="video")),
        }
        for name, options in refused.items():
            with self.subTest(name):
                self.assertIsNone(self.aligner(**options))


class AlignedRelayTests(icy_tests.RelayTestBase):
    def test_an_aac_station_starting_mid_frame_plays_from_its_first_whole_frame(self) -> None:
        body = icy_tests.icy_encode(STREAM, 256, [b"StreamTitle='Trip Song';"])
        self.station.routes["/aac"] = lambda method, headers: icy_tests.reply(b"ICY 200 OK", {
            "content-type": "audio/aacp", "icy-br": "320",
            **({"icy-metaint": "256"} if headers.get("icy-metadata") == "1" else {}),
        }, body if headers.get("icy-metadata") == "1" else STREAM, method)
        media = self.register(f"{self.station.base_url}/aac")
        status, relayed, headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=0-"})
        self.assertEqual((status, headers["content-type"]), (200, "audio/aacp"))
        self.assertEqual(relayed, SOUND)
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"]["title"], "Trip Song")
        # A request that does not start at the beginning gets the bytes as they are.
        status, relayed, _headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=100-"})
        self.assertEqual((status, relayed), (200, STREAM))

    def test_a_plain_live_aac_reply_is_aligned_too_and_mp3_is_untouched(self) -> None:
        self.station.routes["/plain-aac"] = lambda method, headers: icy_tests.reply(
            b"HTTP/1.0 200 OK", {"Content-Type": "audio/aac"}, STREAM, method)
        self.station.routes["/mp3"] = lambda method, headers: icy_tests.reply(
            b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg"}, STREAM, method)
        media = self.register(f"{self.station.base_url}/plain-aac")
        self.assertEqual(self.request("GET", media["relay_url"])[1], SOUND)
        media = self.register(f"{self.station.base_url}/mp3")
        self.assertEqual(self.request("GET", media["relay_url"])[1], STREAM)


class PlainRelayTimingTests(icy_tests.RelayTestBase):
    """A station that ignores Icy-MetaData: its first bytes, then a pause."""

    PAUSE = 1.2

    def first_bytes_after(self, path: str, headers: dict[str, str], first: bytes, rest: bytes,
                          media_type: str = "audio", relayed: bytes | None = None,
                          *, delivery: str = "live", pause: float | None = None) -> tuple[float, bytes]:
        status = b"HTTP/1.1 200 OK" if "Transfer-Encoding" in headers else b"HTTP/1.0 200 OK"
        self.station.routes[path] = lambda method, _headers: [
            icy_tests.reply(status, headers, first, method), self.PAUSE if pause is None else pause, rest,
        ]
        media = self.register(f"{self.station.base_url}{path}", media_type=media_type, delivery=delivery)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        started = time.monotonic()
        connection.request("GET", media["relay_url"])
        reply = connection.getresponse()
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.getheader("Content-Length"), headers.get("Content-Length"))
        piece = reply.read1(65536)
        waited = time.monotonic() - started
        self.assertEqual(piece + reply.read(), first + rest if relayed is None else relayed)
        return waited, piece

    def test_a_slow_endless_audio_reply_passes_its_first_bytes_at_once(self) -> None:
        audio = random.Random(8).randbytes(4000)
        waited, piece = self.first_bytes_after("/slow-mp3", {"Content-Type": "audio/mpeg"}, audio[:1000], audio[1000:])
        self.assertLess(waited, self.PAUSE / 2)
        self.assertEqual(piece, audio[:len(piece)])

    def test_a_slow_aac_reply_is_aligned_from_small_pieces_without_waiting(self) -> None:
        first = STREAM[:len(FALSE_START) + sum(SOUND_FRAMES[:3]) + 7]
        waited, piece = self.first_bytes_after(
            "/slow-aac", {"Content-Type": "audio/aac"}, first, STREAM[len(first):], relayed=SOUND)
        self.assertLess(waited, self.PAUSE / 2)
        self.assertEqual(piece, SOUND[:len(piece)])

    def test_slow_generic_and_sized_live_audio_passes_first_bytes_promptly(self) -> None:
        audio = random.Random(9).randbytes(70 * 1024)
        cases = {
            "/generic": ({"Content-Type": "application/octet-stream"}, "live"),
            "/sized": ({"Content-Type": "audio/mpeg", "Content-Length": str(len(audio))}, "unknown"),
        }
        for path, (headers, delivery) in cases.items():
            with self.subTest(path):
                waited, piece = self.first_bytes_after(path, headers, audio[:5 * 1024], audio[5 * 1024:],
                                                       delivery=delivery)
                self.assertLess(waited, 1.0)
                self.assertEqual(piece, audio[:len(piece)])

    def test_sized_on_demand_audio_and_video_keep_full_reads(self) -> None:
        audio = random.Random(9).randbytes(4000)
        cases = {
            "/sized-file": ({"Content-Type": "audio/mpeg", "Content-Length": str(len(audio))}, "audio", "on-demand"),
            "/video": ({"Content-Type": "video/mp4"}, "video", "live"),
        }
        for path, (headers, media_type, delivery) in cases.items():
            with self.subTest(path):
                waited, _piece = self.first_bytes_after(path, headers, audio[:1000], audio[1000:],
                                                        media_type, delivery=delivery)
                self.assertGreaterEqual(waited, self.PAUSE - 0.2)

    def test_aac_startup_timeout_flushes_the_held_bytes_while_upstream_stalls(self) -> None:
        first = b"held before the next frame"
        pause = MAX_ALIGN_SECONDS + 0.65
        for icy in (False, True):
            with self.subTest(icy=icy):
                headers = {"Content-Type": "audio/aac"}
                wire_first, wire_rest = first, SOUND
                if icy:
                    headers["icy-metaint"] = str(len(first))
                    wire = icy_tests.icy_encode(first + SOUND, len(first), [])
                    headers["Transfer-Encoding"] = "chunked"
                    headers["Connection"] = "close"
                    # Stall in the middle of an HTTP chunk carrying ICY audio.
                    wire_first = f"{len(wire):x}\r\n".encode() + wire[:len(first) + 1]
                    wire_rest = wire[len(first) + 1:] + b"\r\n0\r\n\r\n"
                waited, piece = self.first_bytes_after(
                    "/stalled-icy-aac" if icy else "/stalled-aac", headers, wire_first, wire_rest,
                    relayed=first + SOUND, pause=pause,
                )
                self.assertEqual(piece, first)
                self.assertGreaterEqual(waited, MAX_ALIGN_SECONDS - 0.1)
                self.assertLess(waited, MAX_ALIGN_SECONDS + 0.5)

    def test_remote_html_from_the_media_relay_is_sandboxed_and_inert(self) -> None:
        body = b"<html><body>Upstream document</body></html>"
        self.station.routes["/document"] = lambda method, _headers: icy_tests.reply(
            b"HTTP/1.0 200 OK", {"Content-Type": "text/html", "Content-Length": str(len(body))}, body, method,
        )
        media = self.register(f"{self.station.base_url}/document")
        status, data, headers = self.request("GET", media["relay_url"])
        self.assertEqual((status, data), (200, body))
        self.assertEqual(headers["content-type"], "text/plain; charset=utf-8")
        self.assertEqual(headers["content-security-policy"], "sandbox; default-src 'none'")
        self.assertEqual(headers["x-content-type-options"], "nosniff")


if __name__ == "__main__":
    unittest.main()
