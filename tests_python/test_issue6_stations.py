"""Issue 6 and discussion 8 (v0.1.10 reports): a long own playlist, station
pictures that are not used, and the local port a second copy would share."""
from __future__ import annotations

import http.server
import os
import socket
import threading
import time
import unittest
from unittest import mock

import worldmedia_native
import worldmedia_server
import worldmedia_station_images as station_images
from tests_python.test_station_images import SVG, FolderTestCase, png
from worldmedia_playlists import PlaylistStore, auto_type, parse_playlist, typed_counts


def long_playlist() -> str:
    """60 radio stations as people really write them: near-identical names,
    names with a slash, quoted attributes holding commas, a radio="true" mark
    on some, extensionless addresses (like Live365), and two repeated URLs."""
    lines = ["#EXTM3U"]
    for number in range(1, 61):
        if number % 10 == 0:
            name = f"Nu-Metal/Alternative {number}"
        elif number % 3 == 0:
            name = f"Dream Pop {number}"
        else:
            name = f"Dream Pop {number} (HQ)"
        attributes = f' tvg-logo="https://example.org/logo,{number}.png" group-title="Rock, Indie"'
        if number % 4 == 0:
            attributes += ' radio="true"'
        lines.append(f"#EXTINF:-1{attributes},{name}")
        if number % 5 == 0:
            lines.append(f"https://streaming.live365.com/a{number:05d}")
        else:
            lines.append(f"https://radio.example.org/stream{number}.mp3")
    # An exact repeat (dropped), and an address again under another name (kept).
    lines += ["#EXTINF:-1,Dream Pop 1 (HQ)", "https://radio.example.org/stream1.mp3"]
    lines += ["#EXTINF:-1,Live365 - Alt Radio", "https://streaming.live365.com/a00005"]
    return "\n".join(lines) + "\n"


class LongPlaylistTests(unittest.TestCase):
    def test_every_station_of_a_60_entry_playlist_is_kept_in_order(self) -> None:
        result = parse_playlist(long_playlist(), "tv", count_defaulted=True)
        titles = [item["title"] for item in result["items"]]
        self.assertEqual(len(titles), 61)
        self.assertEqual(titles[0], "Dream Pop 1 (HQ)")
        self.assertEqual(titles[9], "Nu-Metal/Alternative 10")
        self.assertEqual(titles[59], "Nu-Metal/Alternative 60")
        self.assertEqual(titles[60], "Live365 - Alt Radio")
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(result["skipped"], 0)
        # Only the same type + address + name is dropped.
        self.assertEqual(len({item["id"] for item in result["items"]}), 61)
        self.assertEqual(result["items"][0]["_extra"]["artworkUrl"], "https://example.org/logo,1.png")

    def test_an_address_that_does_not_say_radio_takes_the_add_as_type_and_is_counted(self) -> None:
        result = parse_playlist(long_playlist(), "tv", count_defaulted=True)
        by_number = {index + 1: item for index, item in enumerate(result["items"])}
        # stream5.mp3 would be audio; a5 (Live365) has no ending: Add as decides.
        self.assertEqual(by_number[5]["type"], "tv")
        self.assertEqual(by_number[20]["type"], "radio")  # radio="true" wins
        self.assertEqual(by_number[1]["type"], "radio")   # .mp3 ending
        # Every fifth is extensionless; 20, 40 and 60 also carry radio="true";
        # plus the Live365 entry under its second name.
        self.assertEqual(result["defaulted"], 10)
        self.assertEqual(parse_playlist(long_playlist(), "radio", count_defaulted=True)["defaulted"], 10)
        self.assertNotIn("defaulted", parse_playlist(long_playlist(), "tv"))

    def test_the_store_lists_every_channel_after_import_and_reports_the_defaulted_count(self) -> None:
        records = []
        store = PlaylistStore(mock.Mock())
        store._read = lambda: [dict(entry) for entry in records]

        def save(entries):
            records[:] = entries

        store._save = save
        saved = store.import_file({"name": "My stations.m3u", "text": long_playlist(), "default_type": "radio"})
        self.assertEqual(len(saved["playlist"]["items"]), 61)
        self.assertEqual(saved["playlist"]["defaulted"], 10)
        listed = store.list()
        self.assertEqual(len(listed), 1)
        self.assertEqual([item["title"] for item in listed[0]["items"]],
                         [item["title"] for item in saved["playlist"]["items"]])
        self.assertTrue(all(item["type"] == "radio" for item in listed[0]["items"]))


class AutoTypeTests(unittest.TestCase):
    def test_auto_gives_unmarked_entries_the_type_most_marked_entries_have(self) -> None:
        # 60-entry list: the marked ones are radio (.mp3 or radio="true").
        result = parse_playlist(long_playlist(), "auto", count_defaulted=True)
        self.assertEqual((result["default_type"], result["auto"], result["defaulted"]), ("radio", "majority", 10))
        self.assertTrue(all(item["type"] == "radio" for item in result["items"]))
        self.assertEqual(auto_type(long_playlist()), "radio")

    def test_a_file_that_says_tv_more_often_gives_tv(self) -> None:
        text = ("#EXTM3U\n#EXTINF:-1 radio=\"false\",News\nhttps://tv.example.org/a\n"
                "#EXTINF:-1 radio=\"false\",Sport\nhttps://tv.example.org/b\n"
                "#EXTINF:-1,Music\nhttps://radio.example.org/c.mp3\n"
                "#EXTINF:-1,Unknown\nhttps://example.org/d\n")
        result = parse_playlist(text, "auto", count_defaulted=True)
        self.assertEqual((result["default_type"], result["auto"]), ("tv", "majority"))
        self.assertEqual([item["type"] for item in result["items"]], ["tv", "tv", "radio", "tv"])

    def test_a_tie_or_a_file_that_never_says_falls_back_to_tv(self) -> None:
        none_say = "#EXTM3U\n#EXTINF:-1,A\nhttps://example.org/a\n#EXTINF:-1,B\nhttps://example.org/b\n"
        tie = ("#EXTM3U\n#EXTINF:-1 radio=\"false\",A\nhttps://example.org/a\n"
               "#EXTINF:-1,B\nhttps://example.org/b.mp3\n#EXTINF:-1,C\nhttps://example.org/c\n")
        for text in (none_say, tie):
            result = parse_playlist(text, "auto", count_defaulted=True)
            self.assertEqual((result["default_type"], result["auto"]), ("tv", "fallback"))
        # Unparsable or private addresses do not count.
        self.assertEqual(typed_counts("#EXTM3U\n#EXTINF:-1 radio=\"true\",X\nhttp://10.0.0.1/a.mp3\n"), (0, 0))

    def test_explicit_tv_and_radio_mean_what_they_did(self) -> None:
        self.assertEqual(parse_playlist(long_playlist(), "tv")["items"][4]["type"], "tv")
        self.assertEqual(parse_playlist(long_playlist(), "radio")["items"][4]["type"], "radio")
        self.assertNotIn("auto", parse_playlist(long_playlist(), "tv"))

    def test_auto_is_saved_as_the_type_it_chose_so_older_versions_can_read_the_store(self) -> None:
        records = []
        store = PlaylistStore(mock.Mock())
        store._read = lambda: [dict(entry) for entry in records]
        store._save = lambda entries: records.__setitem__(slice(None), entries)
        saved = store.import_file({"name": "Mine.m3u", "text": long_playlist(), "default_type": "auto"})
        self.assertEqual(saved["playlist"]["default_type"], "radio")
        self.assertEqual(records[0]["default_type"], "radio")
        self.assertEqual([item["id"] for item in store.list()[0]["items"]],
                         [item["id"] for item in saved["playlist"]["items"]])
        link = store.import_link({"url": "https://radio.example.org/live.aac", "name": "One", "kind": "stream",
                                  "default_type": "auto"})
        self.assertEqual(link["playlist"]["items"][0]["type"], "radio")
        self.assertIn(records[-1]["default_type"], {"tv", "radio"})
        unmarked = store.import_link({"url": "https://tv.example.org/live", "name": "Two", "kind": "stream",
                                      "default_type": "auto"})
        self.assertEqual(unmarked["playlist"]["items"][0]["type"], "tv")


class PrivateAddressTests(unittest.TestCase):
    def test_entries_for_this_computer_or_a_private_network_are_counted_apart(self) -> None:
        text = ("#EXTM3U\n#EXTINF:-1,Local\nhttp://127.0.0.1:8000/live/abc\n"
                "#EXTINF:-1,Home\nhttp://192.168.1.20/cam\n"
                "#EXTINF:-1,Named\nhttp://localhost:8000/x\n"
                "#EXTINF:-1,IPv6\nhttp://[::1]/x\n"
                "#EXTINF:-1,File\nfile:///C:/music/a.mp3\n"
                "#EXTINF:-1,Login\nhttps://user:pw@10.0.0.1/x\n"
                "#EXTINF:-1,Public\nhttps://radio.example.org/a.mp3\n")
        result = parse_playlist(text, "auto", count_defaulted=True)
        # Still skipped (the rule is unchanged); 4 of the 6 for their address.
        self.assertEqual([item["title"] for item in result["items"]], ["Public"])
        self.assertEqual((result["skipped"], result["private"]), (6, 4))
        self.assertNotIn("private", parse_playlist(text, "tv"))


class SameAddressTests(unittest.TestCase):
    TEXT = ("#EXTM3U\n#EXTINF:-1,Alt Radio\nhttps://streaming.example.org/a1\n"
            "#EXTINF:-1,Alt Radio (backup)\nhttps://streaming.example.org/a1\n"
            "#EXTINF:-1,Alt Radio\nhttps://streaming.example.org/a1\n")

    def test_another_name_on_the_same_address_is_kept_and_the_first_keeps_its_id(self) -> None:
        old_id = parse_playlist("#EXTM3U\n#EXTINF:-1,Alt Radio\nhttps://streaming.example.org/a1\n", "radio")["items"][0]["id"]
        result = parse_playlist(self.TEXT, "radio")
        self.assertEqual([item["title"] for item in result["items"]], ["Alt Radio", "Alt Radio (backup)"])
        self.assertEqual(result["items"][0]["id"], old_id)
        self.assertNotEqual(result["items"][1]["id"], old_id)
        self.assertEqual(result["duplicates"], 1)
        # Stable: the same text gives the same ids every time.
        self.assertEqual([item["id"] for item in parse_playlist(self.TEXT, "radio")["items"]],
                         [item["id"] for item in result["items"]])


class RejectedPictureTests(FolderTestCase):
    def test_each_file_that_is_not_used_is_named_with_a_plain_reason(self) -> None:
        self.put("Good.png", png())
        self.put("Huge.png", b"\x00" * (station_images.MAX_FILE_BYTES + 1))
        self.put("Vector.png", SVG)
        self.put("Logo.svg", SVG)
        self.put("Text.jpg", b"just text")
        self.put("Logo.bmp", b"BM")
        self.put("good.jpg", png())
        listing = self.listing()
        self.assertEqual(self.keys(listing), ["good"])
        # The counts stay as before (the status line), the list adds names.
        self.assertEqual(self.reasons(listing), {"too_large": 1, "not_image": 2, "unsupported_type": 2, "duplicate": 1})
        self.assertEqual(listing["rejected"], [
            {"file": "Huge.png", "reason": "too_large", "text": "too large (the limit is 2 MB)"},
            {"file": "Logo.bmp", "reason": "unsupported_type", "text": "not a supported picture type"},
            {"file": "Logo.svg", "reason": "svg", "text": "SVG is not allowed"},
            {"file": "Text.jpg", "reason": "not_image", "text": "not a valid picture"},
            {"file": "Vector.png", "reason": "svg", "text": "SVG is not allowed"},
            {"file": "good.jpg", "reason": "duplicate", "text": "another picture has the same name"},
        ])
        self.assertEqual(listing["rejected_more"], 0)
        self.assertEqual(listing["images"][0]["file"], "Good.png")

    def test_the_list_is_capped_and_says_how_many_more(self) -> None:
        for index in range(station_images.MAX_REJECTED_LISTED + 5):
            self.put(f"Notes {index:02d}.txt", b"x")
        listing = self.listing()
        self.assertEqual(len(listing["rejected"]), station_images.MAX_REJECTED_LISTED)
        self.assertEqual(listing["rejected_more"], 5)
        self.assertEqual(listing["rejected"][0]["file"], "Notes 00.txt")

    def test_a_cached_check_keeps_its_reason_on_the_next_scan(self) -> None:
        self.put("Vector.png", SVG)
        self.listing()
        with mock.patch.object(station_images.StationImages, "_check_file", side_effect=AssertionError("read")):
            listing = self.listing()
        self.assertEqual(listing["rejected"][0]["reason"], "svg")

    def test_names_are_shown_without_invisible_direction_marks(self) -> None:
        self.assertEqual(station_images.shown_name("evil\u202egnp.exe"), "evilgnp.exe")
        self.assertEqual(len(station_images.shown_name("x" * 300)), 120)
        self.assertTrue(station_images.looks_like_svg(b"\xef\xbb\xbf  <?xml version='1.0'?><svg/>"))
        self.assertFalse(station_images.looks_like_svg(png()))


class LocalPortTests(unittest.TestCase):
    def test_a_port_in_use_by_the_app_server_is_seen_as_taken(self) -> None:
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        self.addCleanup(server.server_close)
        port = server.server_address[1]
        # Before the fix, on Windows, this probe (SO_REUSEADDR) said "free" and
        # a second copy then listened on the same port as the first.
        self.assertFalse(worldmedia_native._can_bind_port(port))
        with self.assertRaises(OSError):
            second = worldmedia_server.ThreadingServer(("127.0.0.1", port), worldmedia_server.WorldMediaHandler)
            second.server_close()

    @unittest.skipUnless(os.name == "nt", "SO_REUSEADDR only lets two listeners share a port on Windows.")
    def test_another_reuse_listener_cannot_join_the_app_port_on_windows(self) -> None:
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        self.addCleanup(server.server_close)
        intruder = socket.socket()
        self.addCleanup(intruder.close)
        intruder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with self.assertRaises(OSError):
            intruder.bind(("127.0.0.1", server.server_address[1]))

    def test_a_closed_server_port_can_be_taken_again_at_once(self) -> None:
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        port = server.server_address[1]
        server.server_close()
        self.assertTrue(worldmedia_native._can_bind_port(port))

    def test_a_busy_preferred_port_is_waited_for_before_another_is_chosen(self) -> None:
        answers = iter([False, False, True])
        now = [0.0]
        slept = []

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        with mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch.object(worldmedia_native, "_can_bind_port", side_effect=lambda port: next(answers)):
            os.environ.pop("WORLDMEDIA_WINDOWS_PORT", None)
            os.environ.pop("WORLDMEDIA_PORT", None)
            port, note = worldmedia_native.choose_port(19500, wait_seconds=8, sleep=sleep, clock=lambda: now[0],
                                                       is_world_media=lambda port: True)
        self.assertEqual(port, 19500)
        self.assertEqual(slept, [0.25, 0.25])
        self.assertEqual(note, "waited 0.5s for port 19500, held by a World Media that was closing")

    def test_a_port_that_stays_busy_falls_back_after_the_wait(self) -> None:
        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        with mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch.object(worldmedia_native, "_can_bind_port", side_effect=lambda port: port != 19500):
            os.environ.pop("WORLDMEDIA_WINDOWS_PORT", None)
            os.environ.pop("WORLDMEDIA_PORT", None)
            port, note = worldmedia_native.choose_port(19500, wait_seconds=1, sleep=sleep, clock=lambda: now[0],
                                                       is_world_media=lambda port: True)
        self.assertEqual(port, worldmedia_native.DEFAULT_PORT)
        self.assertGreaterEqual(now[0], 1)
        self.assertEqual(note, "port 19500 was still held by World Media after 1s")

    def test_a_port_held_by_another_program_is_passed_over_at_once(self) -> None:
        slept = []
        with mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch.object(worldmedia_native, "_can_bind_port", side_effect=lambda port: port != 19500):
            os.environ.pop("WORLDMEDIA_WINDOWS_PORT", None)
            os.environ.pop("WORLDMEDIA_PORT", None)
            port, note = worldmedia_native.choose_port(19500, wait_seconds=8, sleep=slept.append,
                                                       is_world_media=lambda port: False)
        self.assertEqual((port, slept), (worldmedia_native.DEFAULT_PORT, []))
        self.assertEqual(note, "port 19500 is used by another program")

    def test_the_health_answer_tells_world_media_from_other_programs(self) -> None:
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.assertTrue(worldmedia_native._answers_as_world_media(server.server_address[1]))
        # A program that takes the connection but never answers, and one that
        # answers something else, are not World Media; neither takes long.
        silent = socket.socket()
        self.addCleanup(silent.close)
        silent.bind(("127.0.0.1", 0))
        silent.listen(1)
        started = time.monotonic()
        self.assertFalse(worldmedia_native._answers_as_world_media(silent.getsockname()[1], timeout=0.2))
        self.assertLess(time.monotonic() - started, 2)
        other = http.server.HTTPServer(("127.0.0.1", 0), _OtherApp)
        self.addCleanup(other.server_close)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(other.shutdown)
        self.assertFalse(worldmedia_native._answers_as_world_media(other.server_address[1]))

    def test_a_lost_bind_race_moves_to_another_port_instead_of_failing(self) -> None:
        winner = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        self.addCleanup(winner.server_close)
        taken = winner.server_address[1]
        spare = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        free = spare.server_address[1]
        spare.server_close()
        asked = []

        def next_port(tried):
            asked.append(set(tried))
            return free

        server, port, lost = worldmedia_native.bind_with_retry(
            lambda candidate: worldmedia_server.ThreadingServer(("127.0.0.1", candidate), worldmedia_server.WorldMediaHandler),
            taken, next_port)
        self.addCleanup(server.server_close)
        self.assertEqual((port, lost, asked), (free, [taken], [{taken}]))

    def test_binding_gives_up_after_a_few_tries(self) -> None:
        def fail(port):
            raise OSError(10048, "in use")

        with self.assertRaises(RuntimeError):
            worldmedia_native.bind_with_retry(fail, 19500, lambda tried: 19500 + len(tried), attempts=3)


class _OtherApp(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - the http.server name
        body = b'{"ok": true, "app": "Something else"}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    unittest.main()
