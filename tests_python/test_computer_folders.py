from __future__ import annotations

import http.client
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import worldmedia_computer
import worldmedia_server
from worldmedia_computer import ComputerFolders
from worldmedia_native import NativeWindowBridge


def folder_view(entry, available=True):
    return {key: entry[key] for key in ("id", "path", "added")} | {"available": available}


class ComputerFoldersTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.path = self.root / "state" / "computer-folders.json"
        self.store = ComputerFolders(self.path)
        self.media = self.root / "Music"
        self.media.mkdir()

    def link_directory(self, target: Path, link: Path) -> None:
        try:
            if os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(target), str(link))
            else:
                link.symlink_to(target, target_is_directory=True)
        except (ImportError, AttributeError, OSError) as error:
            self.skipTest(f"Directory links are unavailable: {error}")

    def test_add_duplicate_nested_remove_and_persistence(self) -> None:
        self.assertEqual(self.store.list(), [])
        folder = self.store.add(str(self.media / ".." / "Music") + os.sep)
        self.assertEqual(folder["path"], str(self.media))
        self.assertEqual(folder["real"], os.path.realpath(self.media))
        self.assertEqual(datetime.fromisoformat(folder["added"]).utcoffset(), timedelta(0))
        self.assertRegex(folder["id"], r"^[0-9a-f]{32}$")
        self.assertEqual(self.store.add(str(self.media)), folder)
        if os.name == "nt":
            self.assertEqual(self.store.add(str(self.media.with_name("mUSIC"))), folder)
        nested = self.media / "Nested"
        nested.mkdir()
        subfolder = self.store.add(str(nested))
        self.assertNotEqual(subfolder["id"], folder["id"])
        self.assertEqual(
            json.loads(self.path.read_bytes()),
            {"version": 1, "folders": [folder, subfolder]},
        )

        reopened = ComputerFolders(self.path)
        self.assertEqual(reopened.list(), [folder_view(folder), folder_view(subfolder)])
        reopened.remove(folder["id"])
        reopened.remove(folder["id"])
        self.assertEqual(self.store.list(), [folder_view(subfolder)])
        nested.rmdir()
        self.assertEqual(self.store.list(), [folder_view(subfolder, False)])
        reopened.remove(subfolder["id"])
        self.assertEqual(self.store.list(), [])
        self.assertNotEqual(reopened.add(str(self.media))["id"], folder["id"])

    def test_legacy_entry_resolves_once_when_it_becomes_available(self) -> None:
        path = self.root / "Offline"
        folder = self.store.add(str(self.media))
        legacy = {**folder, "path": str(path)}
        del legacy["real"]
        self.path.write_text(json.dumps({"version": 1, "folders": [legacy]}), encoding="utf-8")
        reopened = ComputerFolders(self.path)
        with mock.patch.object(os.path, "realpath", wraps=os.path.realpath) as resolve:
            self.assertEqual(reopened.list(), [folder_view(legacy, False)])
            resolve.assert_not_called()
            self.media.rename(path)
            self.assertEqual(reopened.list(), [folder_view(legacy)])
            self.assertEqual(reopened.list(), [folder_view(legacy)])
            resolve.assert_called_once_with(str(path), strict=True)
        self.assertEqual(json.loads(self.path.read_bytes())["folders"], [{**legacy, "real": str(path)}])

    def test_add_and_file_access_do_not_resolve_or_stat_other_saved_roots(self) -> None:
        offline = self.root / "Offline"
        offline.mkdir()
        saved = self.store.add(str(offline))
        offline.rmdir()
        track = self.media / "Track.mp3"
        track.touch()
        stat, realpath = os.stat, os.path.realpath

        def check(operation):
            def checked(path, *args, **kwargs):
                self.assertNotEqual(os.fspath(path), str(offline))
                return operation(path, *args, **kwargs)
            return checked

        with mock.patch.object(os.path, "realpath", side_effect=check(realpath)) as resolve, \
                mock.patch.object(os, "stat", side_effect=check(stat)):
            new = self.store.add(str(self.media))
            resolve.assert_called_once_with(str(self.media), strict=True)
            self.assertNotEqual(new["id"], saved["id"])
            resolve.reset_mock()
            self.assertEqual(self.store.is_allowed_file(str(track)), realpath(track))
            resolve.assert_called_once_with(str(track), strict=True)

    def test_concurrent_adds_from_separate_instances_keep_all_entries(self) -> None:
        folders = [self.root / f"Folder {index}" for index in range(6)]
        for folder in folders:
            folder.mkdir()
        with ThreadPoolExecutor(max_workers=6) as executor:
            entries = list(executor.map(ComputerFolders(self.path).add, map(str, folders)))
            duplicates = list(executor.map(self.store.add, map(str, folders)))
        self.assertEqual(entries, duplicates)
        self.assertCountEqual(
            self.store.list(), [folder_view(entry) for entry in entries],
        )

    def test_damaged_files_are_empty_and_kept_on_first_write(self) -> None:
        self.path.parent.mkdir()
        for i, damaged in enumerate((
            b"\xff",
            b"{broken",
            b'{"version":2,"folders":[]}',
            b'{"version":1,"folders":[{"id":"bad"}]}',
        ), start=1):
            with self.subTest(damaged=damaged):
                self.path.write_bytes(damaged)
                store = ComputerFolders(self.path)
                self.assertEqual(store.list(), [])
                self.assertEqual(self.path.read_bytes(), damaged)
                entry = store.add(str(self.media))
                self.assertEqual(store.list(), [folder_view(entry)])
                backups = [p.read_bytes() for p in self.path.parent.glob("computer-folders-unreadable-*.json")]
                self.assertEqual(len(backups), i)
                self.assertIn(damaged, backups)

    def test_unreadable_state_lists_empty_without_overwriting_it(self) -> None:
        self.store.add(str(self.media))
        original = self.path.read_bytes()
        with mock.patch.object(Path, "open", side_effect=PermissionError):
            self.assertEqual(ComputerFolders(self.path).list(), [])
            with self.assertRaises(PermissionError):
                self.store.add(str(self.media))
        self.assertEqual(self.path.read_bytes(), original)

    def test_folder_cap_still_allows_duplicates(self) -> None:
        self.assertEqual(worldmedia_computer.MAX_FOLDERS, 200)
        first = self.store.add(str(self.media))
        folders = [first]
        for index in range(1, 200):
            folder = self.root / f"Saved {index}"
            folder.mkdir()
            folders.append({**first, "path": str(folder), "real": str(folder), "id": f"{index:032x}"})
        self.path.write_text(json.dumps({"version": 1, "folders": folders}), encoding="utf-8")
        self.assertEqual(self.store.add(str(self.media)), first)
        extra = self.root / "Extra"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "up to 200 folders"):
            self.store.add(str(extra))
        self.assertEqual(json.loads(self.path.read_bytes())["folders"], folders)

    def test_refuses_invalid_paths(self) -> None:
        file = self.media / "file.mp3"
        file.touch()
        for path in (
            "", None, "relative", str(file), str(self.root / "Missing"), str(self.media) + "\0",
            r"\\.\C:\Windows", r"\\?\GLOBALROOT\Device\HarddiskVolume1\Windows",
            r"\\server\pipe\example", r"C:Music", r"\Music",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.store.add(path)
        self.assertFalse(self.path.exists())

    @unittest.skipUnless(os.name == "nt", "Windows path forms.")
    def test_colon_in_absolute_windows_paths_is_refused_before_resolution(self) -> None:
        for path in (
            r"D:\Music:stream", r"D:\Music:stream\..\Track.mp3", r"\\?\D:\Music:stream",
            r"\\server\share\Music:stream", r"\\?\UNC\server\share\Music:stream",
            r"\\server\share:stream\Track.mp3",
        ):
            with self.subTest(path=path), mock.patch.object(os.path, "realpath") as resolve:
                with self.assertRaises(ValueError):
                    self.store.add(path)
                self.assertIsNone(self.store.is_allowed_file(path))
                resolve.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows path forms.")
    def test_whole_drives_and_unc_are_valid_path_forms(self) -> None:
        for path in ("D:\\", r"\\server\share", r"\\server\share\Music", r"\\?\UNC\server\share"):
            with self.subTest(path=path):
                self.assertEqual(worldmedia_computer._absolute_path(path), path)
        share_key = worldmedia_computer._path_key(r"\\server\share")
        file_key = worldmedia_computer._path_key(r"\\SERVER\SHARE\Music\Track.mp3")
        self.assertEqual(os.path.commonpath((file_key, share_key)), share_key)
        self.assertEqual(worldmedia_computer._path_key(r"\\?\UNC\server\share"), share_key)

    def test_file_boundary_and_case(self) -> None:
        self.store.add(str(self.media))
        outside = self.root / "Music extra"
        outside.mkdir()
        track = self.media / "Track.mp3"
        track.touch()
        other_track = outside / "Track.mp3"
        other_track.touch()
        self.assertEqual(self.store.is_allowed_file(str(track)), os.path.realpath(track))
        alternate = self.root / "mUSIC" / "tRACK.MP3"
        self.assertEqual(self.store.is_allowed_file(str(alternate)), os.path.realpath(track) if alternate.exists() else None)
        for refused in (
            other_track, self.media / ".." / outside.name / track.name, self.media,
            self.media / "missing.mp3", Path("Music") / track.name, str(track) + "\0",
        ):
            with self.subTest(refused=refused):
                self.assertIsNone(self.store.is_allowed_file(str(refused)))

    def test_file_replacing_a_saved_directory_is_refused(self) -> None:
        self.store.add(str(self.media))
        self.media.rmdir()
        self.media.touch()
        self.assertIsNone(self.store.is_allowed_file(str(self.media)))

    @unittest.skipUnless(hasattr(os, "mkfifo"), "Filesystem FIFOs are unavailable.")
    def test_nonregular_file_is_refused(self) -> None:
        self.store.add(str(self.media))
        fifo = self.media / "pipe"
        os.mkfifo(fifo)
        self.assertIsNone(self.store.is_allowed_file(str(fifo)))

    def test_link_from_root_to_outside_is_refused_until_target_is_added(self) -> None:
        outside = self.root / "Outside"
        outside.mkdir()
        track = outside / "Track.mp3"
        track.touch()
        escape = self.media / "Escape"
        self.link_directory(outside, escape)
        self.store.add(str(self.media))
        self.assertIsNone(self.store.is_allowed_file(str(escape / track.name)))
        self.store.add(str(outside))
        self.assertEqual(self.store.is_allowed_file(str(escape / track.name)), os.path.realpath(track))

    def test_saved_junction_or_symlink_root_authorizes_its_target_and_deduplicates(self) -> None:
        track = self.media / "Track.mp3"
        track.touch()
        alias = self.root / "Alias"
        self.link_directory(self.media, alias)
        folder = self.store.add(str(alias))
        self.assertEqual(folder["path"], str(alias))
        self.assertEqual(folder["real"], os.path.realpath(self.media))
        self.assertEqual(self.store.add(str(self.media)), folder)
        self.assertEqual(self.store.is_allowed_file(str(alias / track.name)), os.path.realpath(track))
        self.assertEqual(self.store.is_allowed_file(str(track)), os.path.realpath(track))

    def test_retargeted_saved_alias_does_not_grant_access_to_new_target(self) -> None:
        alias = self.root / "Alias"
        self.link_directory(self.media, alias)
        saved = self.store.add(str(alias))
        outside = self.root / "Outside"
        outside.mkdir()
        track = self.media / "Track.mp3"
        track.touch()
        (outside / track.name).touch()
        if os.name == "nt":
            alias.rmdir()
        else:
            alias.unlink()
        self.link_directory(outside, alias)

        self.assertEqual(self.store.list(), [folder_view(saved)])
        self.assertIsNone(self.store.is_allowed_file(str(alias / track.name)))
        self.assertEqual(self.store.is_allowed_file(str(track)), os.path.realpath(track))

    def test_availability_wait_is_shared_and_stuck_probes_are_reused(self) -> None:
        slow = [self.media, self.root / "Slow"]
        slow[1].mkdir()
        fast = self.root / "Fast"
        fast.mkdir()
        for folder in [*slow, fast]:
            self.store.add(str(folder))
        release = threading.Event()

        def available(path):
            if Path(path) in slow:
                return release.wait(5)
            return True

        with mock.patch.object(worldmedia_computer, "_folder_available", side_effect=available) as probe, \
                mock.patch.object(worldmedia_computer, "AVAILABILITY_TIMEOUT", 0.2) as timeout, \
                mock.patch.object(worldmedia_computer, "wait", wraps=worldmedia_computer.wait) as wait:
            try:
                for _ in range(2):
                    self.assertEqual([item["available"] for item in self.store.list()], [False, False, True])
                self.assertEqual(wait.call_count, 2)
                for call in wait.call_args_list:
                    self.assertEqual(len(call.args[0]), 3)
                    self.assertEqual(call.kwargs, {"timeout": timeout})
                for folder in slow:
                    self.assertEqual(probe.call_args_list.count(mock.call(str(folder))), 1)
            finally:
                release.set()
                with self.store._probe_lock:
                    pending = list(self.store._probes.values())
                for future in pending:
                    future.result(timeout=5)


class ComputerFolderRouteTests(unittest.TestCase):
    route = "/api/v1/computer/folders"

    @classmethod
    def setUpClass(cls) -> None:
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        cls.addClassCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(thread.join, 5)
        cls.addClassCleanup(server.shutdown)
        cls.port = server.server_port
        cls.origin = f"http://127.0.0.1:{cls.port}"

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.media = self.root / "Private Music"
        self.media.mkdir()
        self.store = ComputerFolders(self.root / "state" / "computer-folders.json")
        self.enterContext(mock.patch.object(worldmedia_server, "COMPUTER_FOLDERS", self.store))
        status, payload = self.request("GET", "/api/v1/session")
        self.assertEqual(status, 200)
        self.token_header = {"X-WorldMedia-Token": payload["data"]["token"]}
        self.post_headers = {**self.token_header, "Origin": self.origin, "Content-Type": "application/json"}

    def request(self, method, route, headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, route, body, headers or {})
            response = connection.getresponse()
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def assert_refused(self, method, route, headers, body, expected_status, expected_code):
        status, payload = self.request(method, route, headers, body)
        self.assertEqual(status, expected_status)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], expected_code)
        return payload["error"]

    def test_list_add_remove_and_path_privacy(self) -> None:
        logs = io.StringIO()
        with mock.patch.object(worldmedia_server.sys, "stderr", logs):
            status, payload = self.request("GET", self.route, self.token_header)
            self.assertEqual((status, payload["data"]), (200, {"folders": []}))
            status, payload = self.request(
                "POST", self.route + "/add", self.post_headers, json.dumps({"path": str(self.media)}),
            )
            self.assertEqual(status, 200)
            folder = payload["data"]["folder"]
            self.assertEqual(set(folder), {"id", "path", "available", "added"})
            self.assertEqual(folder["path"], str(self.media))
            self.assertIs(folder["available"], True)
            self.assertEqual(payload["data"]["folders"], [folder])
            status, payload = self.request("GET", self.route, self.token_header)
            self.assertEqual((status, payload["data"]), (200, {"folders": [folder]}))
            status, payload = self.request(
                "POST", self.route + "/remove", self.post_headers, json.dumps({"id": folder["id"]}),
            )
            self.assertEqual((status, payload["data"]), (200, {"folders": []}))
        self.assertNotIn("Private Music", logs.getvalue())
        self.assertNotIn(urllib.parse.quote(str(self.media), safe=""), logs.getvalue())

    def test_add_response_hides_real_when_folder_disappears_from_listing(self) -> None:
        with mock.patch.object(self.store, "list", return_value=[]), \
                mock.patch.object(self.store.library, "start"):
            status, payload = self.request(
                "POST", self.route + "/add", self.post_headers, json.dumps({"path": str(self.media)}),
            )
        self.assertEqual(status, 200)
        [entry] = json.loads(self.store.path.read_bytes())["folders"]
        self.assertEqual(payload["data"], {"folders": [], "folder": folder_view(entry, False)})

    def test_all_routes_require_authentication_and_check_origin(self) -> None:
        self.assert_refused("GET", self.route, {}, None, 403, "INVALID_TOKEN")
        self.assert_refused("GET", self.route, {**self.token_header, "Origin": "https://evil.example"},
                            None, 403, "INVALID_ORIGIN")
        for suffix in ("/add", "/remove"):
            with self.subTest(suffix=suffix):
                route = self.route + suffix
                self.assert_refused("POST", route, {**self.post_headers, "X-WorldMedia-Token": "wrong"},
                                    "{}", 403, "INVALID_TOKEN")
                self.assert_refused("POST", route, {**self.post_headers, "Origin": "https://evil.example"},
                                    "{}", 403, "INVALID_ORIGIN")
                self.assert_refused("POST", route, {**self.token_header, "Content-Type": "application/json"},
                                    "{}", 403, "ORIGIN_REQUIRED")
                self.assert_refused("POST", route, {**self.post_headers, "Content-Type": "text/plain"},
                                    "{}", 415, "JSON_REQUIRED")
                self.assert_refused("GET", route, self.token_header, None, 405, "METHOD_NOT_ALLOWED")
        self.assert_refused("POST", self.route, self.post_headers, "{}", 405, "METHOD_NOT_ALLOWED")

    def test_invalid_requests_and_body_limits(self) -> None:
        route = self.route + "/add"
        missing = str(self.root / "Private missing path")
        error = self.assert_refused("POST", route, self.post_headers, json.dumps({"path": missing}),
                                    400, "INVALID_COMPUTER_FOLDER")
        self.assertEqual(error["message"], "That folder was not found.")
        self.assert_refused("POST", route, self.post_headers, "{invalid", 400, "MALFORMED_JSON")
        self.assert_refused("POST", route, self.post_headers, '{"path":null}', 400, "INVALID_COMPUTER_FOLDER")
        self.assert_refused("POST", route, self.post_headers, json.dumps({"path": str(self.media), "id": ""}),
                            400, "INVALID_COMPUTER_FOLDER")
        self.assert_refused("POST", route, self.post_headers, " " * (16 * 1024 + 1), 413, "BODY_TOO_LARGE")
        route = self.route + "/remove"
        self.assert_refused("POST", route, self.post_headers, '{"id":[]}', 400, "INVALID_COMPUTER_FOLDER")
        self.assert_refused("POST", route, self.post_headers, " " * 1025, 413, "BODY_TOO_LARGE")
        self.assertEqual(self.store.list(), [])


class ComputerFolderPickerTests(unittest.TestCase):
    error = {"path": "", "error": "The folder picker could not be opened."}

    def test_chosen_cancelled_and_failed_dialogs_use_the_form_invoke(self) -> None:
        bridge = NativeWindowBridge()
        form = SimpleNamespace(
            IsDisposed=False, Disposing=False, IsHandleCreated=True, InvokeRequired=True,
            Invoke=mock.Mock(side_effect=lambda action: action()),
        )
        bridge._bind_window(SimpleNamespace(native=form))
        self.assertEqual(bridge.set_theme("forest")["theme"], "forest")
        action = mock.Mock(side_effect=lambda callback: callback)
        dialog = mock.Mock(side_effect=[(r"D:\Music",), None, OSError(r"Private path: D:\Music")])
        modules = {
            "System": SimpleNamespace(Action=action),
            "webview.platforms.winforms": SimpleNamespace(OpenFolderDialog=SimpleNamespace(show=dialog)),
        }
        profile = self.enterContext(tempfile.TemporaryDirectory())
        with mock.patch.dict("sys.modules", modules), mock.patch.dict(os.environ, HOMEPATH=r"\Users\test"):
            with mock.patch.dict(os.environ, USERPROFILE=profile):
                self.assertEqual(bridge.pick_media_folder(), {"path": r"D:\Music"})
            with mock.patch.dict(os.environ, USERPROFILE=str(Path(profile) / "missing")):
                self.assertEqual(bridge.pick_media_folder(), {"path": ""})
            with mock.patch.dict(os.environ):
                os.environ.pop("USERPROFILE", None)
                self.assertEqual(bridge.pick_media_folder(), self.error)
            form.Invoke.side_effect = RuntimeError("Handle closed")
            self.assertEqual(bridge.pick_media_folder(), self.error)
        self.assertEqual(form.Invoke.call_args_list, action.call_args_list)
        self.assertEqual(form.Invoke.call_count, 4)
        self.assertEqual(dialog.call_args_list, [
            mock.call(form, profile, False), mock.call(form, "", False), mock.call(form, "", False),
        ])

    def test_missing_disposed_or_uncreated_form_returns_an_error(self) -> None:
        bridge = NativeWindowBridge()
        self.assertEqual(bridge.pick_media_folder(), self.error)
        invoke = mock.Mock()
        for disposed, disposing, created in ((True, False, True), (False, True, True), (False, False, False)):
            with self.subTest(disposed=disposed, disposing=disposing, created=created):
                bridge._bind_window(SimpleNamespace(native=SimpleNamespace(
                    IsDisposed=disposed, Disposing=disposing, IsHandleCreated=created, Invoke=invoke,
                )))
                self.assertEqual(bridge.pick_media_folder(), self.error)
        invoke.assert_not_called()
