from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest import mock

from dev_environment import configure_local_cache
from worldmedia_runtime import (
    DEFAULT_SERVER_PORT,
    PORTABLE_STATE_DIR,
    PROFILE_TRANSFER_KEYS,
    configured_server_port,
    get_runtime_paths,
    load_profile_transfer,
    migrate_legacy_state,
    normalize_server_port,
    portable_root,
    probe_writable,
    runtime_status,
    save_profile_transfer,
    save_server_port,
    profile_transfer_path,
    server_port_config_path,
)


configure_local_cache()
from worldmedia_security import (
    ApiError,
    MAX_JSON_BODY,
    error_envelope,
    redact_text,
    reserve_output_path,
    sanitize_filename,
    success_envelope,
    new_session_token,
    validate_control_host,
)


class SecurityRuntimeTests(unittest.TestCase):
    def test_test_scratch_directory_is_inside_workspace(self) -> None:
        scratch = Path(tempfile.gettempdir()).resolve()
        scratch.relative_to(Path(__file__).resolve().parents[1])
        self.assertEqual(os.environ["TEMP"], os.environ["TMP"])

    def test_default_state_is_beside_portable_launcher(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            portable = Path(temp) / "portable"
            with mock.patch.dict(
                os.environ, {"WORLDMEDIA_PORTABLE_ROOT": str(portable)}, clear=True
            ):
                paths = get_runtime_paths()
            self.assertEqual(paths.state_root, portable.resolve() / PORTABLE_STATE_DIR)

    def test_legacy_profile_migration_preserves_source_and_favorites(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local = root / "local"
            portable = root / "portable"
            favorite = (
                local
                / "WorldMediaWindows"
                / "webview2_data"
                / "EBWebView"
                / "Default"
                / "Local Storage"
                / "leveldb"
                / "favorite-sentinel.ldb"
            )
            favorite.parent.mkdir(parents=True)
            favorite.write_text("58 favorites", encoding="utf-8")
            environment = {
                "LOCALAPPDATA": str(local),
                "WORLDMEDIA_PORTABLE_ROOT": str(portable),
            }
            with mock.patch.dict(os.environ, environment, clear=True):
                paths = get_runtime_paths()
                self.assertTrue(migrate_legacy_state(paths))
                self.assertFalse(migrate_legacy_state(paths))

            migrated = paths.state_root / favorite.relative_to(local / "WorldMediaWindows")
            self.assertEqual(migrated.read_text(encoding="utf-8"), "58 favorites")
            self.assertEqual(favorite.read_text(encoding="utf-8"), "58 favorites")

    def test_portable_root_uses_executable_parent_not_meipass(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable = root / "portable" / "WorldMediaWindows.exe"
            meipass = root / "temporary" / "_MEI123"
            with mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(sys, "frozen", True, create=True), \
                    mock.patch.object(sys, "executable", str(executable)), \
                    mock.patch.object(sys, "_MEIPASS", str(meipass), create=True):
                self.assertEqual(portable_root(), executable.parent.resolve())
                self.assertNotEqual(portable_root(), meipass.resolve())

    def test_runtime_paths_and_atomic_write_probes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            paths = get_runtime_paths(portable=base / "portable", state=base / "state")
            data = runtime_status(paths)
            self.assertEqual(paths.downloads_root, base / "portable" / "downloads")
            self.assertEqual(paths.tools_root, base / "portable" / "tools" / "ffmpeg")
            self.assertTrue(data["portable_writable"])
            self.assertFalse(data["using_fallback"])
            self.assertIsNone(data["fallback_reason"])
            self.assertEqual(list(paths.downloads_root.glob(".worldmedia-write-*.tmp")), [])
            self.assertEqual(list(paths.tools_root.glob(".worldmedia-write-*.tmp")), [])

            with mock.patch("worldmedia_runtime.os.open", side_effect=PermissionError("private detail")):
                writable, reason = probe_writable(base / "blocked")
            self.assertFalse(writable)
            self.assertEqual(reason, "Portable downloads/tools directory is not writable.")
            self.assertNotIn("private detail", reason)

    def test_server_port_preference_is_validated_and_persisted_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            paths = get_runtime_paths(portable=base / "portable", state=base / "state")
            self.assertEqual(configured_server_port(paths), DEFAULT_SERVER_PORT)
            self.assertEqual(save_server_port(21345, paths), 21345)
            self.assertEqual(configured_server_port(paths), 21345)
            self.assertEqual(
                json.loads(server_port_config_path(paths).read_text(encoding="utf-8")),
                {"server_port": 21345},
            )
            for invalid in (True, "21345", 1023, 65536):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        normalize_server_port(invalid)

    def test_profile_handoff_is_bounded_atomic_and_whitelisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            paths = get_runtime_paths(portable=base / "portable", state=base / "state")
            values = {
                "worldmedia.favorites.v1": '[{"id":"saved:1"}]',
                "worldmedia.settings.v1": '{"theme":"forest"}',
            }
            self.assertEqual(save_profile_transfer(values, paths), values)
            self.assertEqual(load_profile_transfer(paths), values)
            stored = json.loads(profile_transfer_path(paths).read_text(encoding="utf-8"))
            self.assertEqual(stored["values"], values)
            self.assertEqual(set(values), PROFILE_TRANSFER_KEYS & set(values))
            for invalid in (
                [],
                {"unknown": "value"},
                {"worldmedia.favorites.v1": 12},
            ):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        save_profile_transfer(invalid, paths)

    def test_windows_filename_sanitization_and_atomic_reservation(self) -> None:
        cases = {
            '  quote" and <tag>  ': "quote_ and _tag_.mp4",
            "..\\..\\escape": "_.._escape.mp4",
            "CON": "_CON.mp4",
            "Lpt9.txt": "_Lpt9.txt.mp4",
            "trailing...   ": "trailing.mp4",
            "Música 東京 🎧": "Música 東京 🎧.mp4",
            "line\nfeed\x00name": "linefeedname.mp4",
        }
        for title, expected in cases.items():
            with self.subTest(title=title):
                self.assertEqual(sanitize_filename(title, "mp4"), expected)
        self.assertLessEqual(len(sanitize_filename("x" * 1000, "mp3")), 124)
        with self.assertRaises(ValueError):
            sanitize_filename("title", "../exe")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = reserve_output_path(root, "../CON", "mp3", timestamp="20260710-120000")
            second = reserve_output_path(root, "../CON", "mp3", timestamp="20260710-120000")
            third = reserve_output_path(root, "../CON", "mp3", timestamp="20260710-120000")
            self.assertEqual(first.name, "_CON.mp3")
            self.assertEqual(second.name, "_CON (20260710-120000).mp3")
            self.assertEqual(third.name, "_CON (20260710-120000-2).mp3")
            for candidate in (first, second, third):
                self.assertTrue(candidate.is_file())
                candidate.resolve().relative_to(root.resolve())

    def test_redaction_and_versioned_envelopes_are_bounded(self) -> None:
        first_token = new_session_token()
        second_token = new_session_token()
        self.assertNotEqual(first_token, second_token)
        self.assertGreaterEqual(len(first_token), 32)
        secret = "secret-value"
        text = redact_text(
            f"failed https://user:pass@example.test/media?token={secret} "
            f"X-WorldMedia-Token: {secret} /api/v1/media/AbCdEfGhIjKlMnOp "
            "/api/v1/assets/OpaqueAssetCapability1234567890"
        )
        self.assertNotIn(secret, text)
        self.assertNotIn("user:pass", text)
        self.assertIn("?<redacted>", text)
        self.assertIn("/api/v1/media/<redacted>", text)
        self.assertIn("/api/v1/assets/<redacted>", text)
        request_id = "a" * 24
        success = success_envelope({"value": 1}, request_id)
        failure = error_envelope(ApiError(400, "BAD_REQUEST", "safe"), request_id)
        self.assertEqual(success["api_version"], "v1")
        self.assertTrue(success["ok"])
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["error"]["code"], "BAD_REQUEST")
        self.assertLessEqual(len(json.dumps(failure)), MAX_JSON_BODY)

        duplicate_headers = Message()
        duplicate_headers.add_header("Host", "127.0.0.1:9124")
        duplicate_headers.add_header("Host", "localhost:9124")
        with self.assertRaises(ApiError) as duplicate:
            validate_control_host(duplicate_headers, 9124)
        self.assertEqual(duplicate.exception.code, "DUPLICATE_HEADER")


if __name__ == "__main__":
    unittest.main()
