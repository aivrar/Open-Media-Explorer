from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worldmedia_ffmpeg import (
    FfmpegError,
    FfmpegService,
    InstallCancelled,
    ToolCandidate,
    discover_toolchain,
    download_asset,
    inspect_zip,
    install_managed,
    managed_root,
    parse_release_asset,
    probe_toolchain,
    query_release_asset,
    remove_managed,
    _replace_directory_with_retry,
    _safe_remove_tree,
)
from worldmedia_media import MediaError
from worldmedia_runtime import get_runtime_paths


def capable_runner(command, **_kwargs):
    operation = command[-1]
    executable = Path(command[0]).name.lower()
    if operation == "-version":
        product = "ffprobe" if "ffprobe" in executable else "ffmpeg"
        output = f"{product} version n8.1-test Copyright FFmpeg\n"
    elif operation == "-protocols":
        output = "Supported file protocols:\nInput:\nhttp\nhttps\npipe\nOutput:\nhttp\nhttps\npipe\n"
    elif operation == "-demuxers":
        output = "Demuxers:\n D hls\n D mov\n D mp3\n D mpegts\n"
    elif operation == "-decoders":
        output = "Decoders:\n A aac\n V h264\n A mp3\n"
    elif operation == "-encoders":
        output = "Encoders:\n A aac\n A libmp3lame\n V libx264\n"
    elif operation == "-muxers":
        output = "Muxers:\n E mp3\n E mp4\n"
    elif operation == "-filters":
        output = "Filters:\n T.C alimiter A->A\n TSC bass A->A\n TSC equalizer A->A\n TSC treble A->A\n T.C volume A->A\n"
    else:
        raise AssertionError(command)
    return SimpleNamespace(returncode=0, stdout=output, stderr="")


def make_package(*, entries: dict[str, bytes] | None = None, compression=zipfile.ZIP_STORED) -> bytes:
    values = entries or {
        "ffmpeg-test/bin/ffmpeg.exe": b"ffmpeg-binary",
        "ffmpeg-test/bin/ffprobe.exe": b"ffprobe-binary",
        "ffmpeg-test/LICENSE.txt": b"GPL license material",
        "ffmpeg-test/doc/readme.txt": b"source documentation",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as package:
        for name, data in values.items():
            package.writestr(name, data)
    return output.getvalue()


def release_json(content: bytes, *, digest: str | None = None) -> dict:
    return {
        "url": "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/123",
        "id": 123,
        "tag_name": "latest",
        "name": "Latest Auto-Build",
        "published_at": "2026-07-10T13:44:00Z",
        "draft": False,
        "prerelease": False,
        "assets": [{
            "id": 456,
            "name": "ffmpeg-n8.1-latest-win64-gpl-8.1.zip",
            "state": "uploaded",
            "size": len(content),
            "digest": digest or f"sha256:{hashlib.sha256(content).hexdigest()}",
            "content_type": "application/zip",
            "browser_download_url": (
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
                "ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
            ),
        }],
    }


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200, headers: dict[str, str] | None = None) -> None:
        self.body = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}
        self.closed = False

    def read(self, size: int) -> bytes:
        return self.body.read(size)

    def getheader(self, name: str):
        return self.headers.get(name)

    def close(self) -> None:
        self.closed = True


class FakeUpstream:
    def __init__(self, body: bytes, *, status: int = 200, headers: dict[str, str] | None = None) -> None:
        self.response = FakeResponse(body, status, headers)
        self.closed = False

    def iter_chunks(self, *, cancel=None, chunk_size=64 * 1024):
        while True:
            if cancel and cancel.is_set():
                raise MediaError(408, "MEDIA_CANCELLED", "cancelled")
            chunk = self.response.read(min(chunk_size, 64 * 1024))
            if not chunk:
                return
            yield chunk

    def close(self) -> None:
        self.closed = True
        self.response.close()


class FakeConnector:
    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.calls: list[str] = []

    def open(self, url: str, **_kwargs):
        self.calls.append(url)
        if not self.replies:
            raise AssertionError("unexpected connector call")
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class ProbeAndDiscoveryTests(unittest.TestCase):
    def test_probe_requires_both_programs_and_every_capture_capability(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ffmpeg = root / "ffmpeg.exe"
            ffprobe = root / "ffprobe.exe"
            ffmpeg.touch()
            ffprobe.touch()
            candidate = ToolCandidate("PATH", ffmpeg, ffprobe, False)
            result = probe_toolchain(candidate, capable_runner)
            self.assertTrue(result.ready)
            self.assertIn("libx264", result.capabilities["encoders"])
            ffprobe.unlink()
            self.assertFalse(probe_toolchain(candidate, capable_runner).ready)

    def test_discovery_falls_through_an_incapable_earlier_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = ToolCandidate("override", root / "one-ffmpeg.exe", root / "one-ffprobe.exe", False)
            second = ToolCandidate("LocalAppData", root / "two-ffmpeg.exe", root / "two-ffprobe.exe", True)
            for candidate in (first, second):
                candidate.ffmpeg_path.touch()
                candidate.ffprobe_path.touch()

            def runner(command, **kwargs):
                result = capable_runner(command, **kwargs)
                if command[0] == str(first.ffmpeg_path) and command[-1] == "-encoders":
                    result.stdout = "Encoders:\n A aac\n"
                return result

            with mock.patch("worldmedia_ffmpeg.discovery_candidates", return_value=[first, second]):
                status, selected = discover_toolchain(runner=runner)
            self.assertEqual(status.source, "LocalAppData")
            self.assertTrue(status.managed)
            self.assertEqual(selected, second)

    def test_corrupt_managed_pointer_is_ignored_without_escaping_its_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            paths = get_runtime_paths(portable=base / "portable", state=base / "state")
            paths.tools_root.mkdir(parents=True)
            (paths.tools_root / "current.json").write_text(
                '{"schema_version":1,"relative_path":"../../outside"}', encoding="utf-8",
            )
            outside = base / "outside" / "bin"
            outside.mkdir(parents=True)
            (outside / "ffmpeg.exe").touch()
            (outside / "ffprobe.exe").touch()
            with mock.patch("worldmedia_ffmpeg.shutil.which", return_value=None):
                status, selected = discover_toolchain(paths, runner=capable_runner)
            self.assertEqual(status.state, "missing")
            self.assertIsNone(selected)

    def test_probe_never_uses_a_shell_and_has_a_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ffmpeg, ffprobe = root / "ffmpeg.exe", root / "ffprobe.exe"
            ffmpeg.touch()
            ffprobe.touch()
            calls = []

            def runner(command, **kwargs):
                calls.append((command, kwargs))
                return capable_runner(command, **kwargs)

            self.assertTrue(probe_toolchain(ToolCandidate("PATH", ffmpeg, ffprobe, False), runner).ready)
            self.assertTrue(all(call[1]["shell"] is False for call in calls))
            self.assertTrue(all(call[1]["timeout"] > 0 for call in calls))


class ReleaseAndDownloadTests(unittest.TestCase):
    def test_release_parser_pins_repository_state_name_size_digest_and_url(self) -> None:
        content = make_package()
        valid = release_json(content)
        asset = parse_release_asset(valid, minimum_size=1, maximum_size=len(content) + 1)
        self.assertEqual(asset.asset_id, 456)
        mutations = [
            ("wrong repository", lambda value: value.update(url="https://api.github.com/repos/evil/repo/releases/123")),
            ("wrong tag", lambda value: value.update(tag_name="nightly")),
            ("draft", lambda value: value.update(draft=True)),
            ("duplicate", lambda value: value["assets"].append(dict(value["assets"][0]))),
            ("bad digest", lambda value: value["assets"][0].update(digest="sha256:1234")),
            ("bad host", lambda value: value["assets"][0].update(browser_download_url="https://evil.test/file.zip")),
        ]
        for label, mutate in mutations:
            candidate = json.loads(json.dumps(valid))
            mutate(candidate)
            with self.subTest(label=label), self.assertRaises(FfmpegError):
                parse_release_asset(candidate, minimum_size=1, maximum_size=len(content) + 1)

    def test_release_query_retries_transport_errors_and_is_bounded(self) -> None:
        content = make_package()
        body = json.dumps(release_json(content)).encode()
        failure = MediaError(502, "FAILED", "failed", True)
        connector = FakeConnector([failure, FakeUpstream(body)])
        with mock.patch("worldmedia_ffmpeg.threading.Event.wait", return_value=False):
            asset = query_release_asset(connector, minimum_size=1, maximum_size=len(content) + 1)
        self.assertEqual(asset.release_id, 123)
        self.assertEqual(len(connector.calls), 2)

    def test_download_rejects_bad_digest_truncation_and_honors_cancellation(self) -> None:
        content = make_package()
        value = release_json(content)
        asset = parse_release_asset(value, minimum_size=1, maximum_size=len(content) + 1)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "asset.part"
            bad = FakeConnector([FakeUpstream(content, headers={"Content-Length": str(len(content))})])
            bad_asset = parse_release_asset(
                release_json(content, digest="sha256:" + "0" * 64), minimum_size=1, maximum_size=len(content) + 1
            )
            with self.assertRaises(FfmpegError) as error:
                download_asset(bad_asset, target, connector=bad, retries=1, maximum_bytes=len(content) + 1)
            self.assertEqual(error.exception.code, "BAD_ASSET_DIGEST")
            self.assertFalse(target.exists())

            truncated = FakeConnector([FakeUpstream(content[:-4], headers={"Content-Length": str(asset.size)})])
            with self.assertRaises(FfmpegError) as error:
                download_asset(asset, target, connector=truncated, retries=1, maximum_bytes=len(content) + 1)
            self.assertEqual(error.exception.code, "ASSET_LENGTH_MISMATCH")

            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(InstallCancelled):
                download_asset(asset, target, connector=FakeConnector([]), cancel=cancelled)


class ArchiveSafetyTests(unittest.TestCase):
    def inspect_bytes(self, content: bytes, **kwargs):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "archive.zip"
            archive.write_bytes(content)
            return inspect_zip(archive, **kwargs)

    def test_valid_archive_and_cancellation(self) -> None:
        members, root = self.inspect_bytes(make_package())
        self.assertEqual(root, "ffmpeg-test")
        self.assertGreaterEqual(len(members), 3)
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(InstallCancelled):
            self.inspect_bytes(make_package(), cancel=cancelled)

    def test_rejects_traversal_drive_backslash_symlink_and_missing_material(self) -> None:
        unsafe_entries = [
            {"../escape": b"x"},
            {"C:/escape": b"x"},
            {"root\\escape": b"x"},
            {"root/file:stream": b"x"},
            {"root/NUL.txt": b"x"},
            {"root/trailing. ": b"x"},
            {"root/File": b"x", "root/file": b"y"},
            {"one/file": b"x", "two/file": b"x"},
            {"root/bin/ffmpeg.exe": b"x", "root/LICENSE": b"x"},
            {"root/bin/ffmpeg.exe": b"x", "root/bin/ffprobe.exe": b"x"},
        ]
        for entries in unsafe_entries:
            with self.subTest(entries=list(entries)), self.assertRaises(FfmpegError):
                self.inspect_bytes(make_package(entries=entries))

        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as package:
            info = zipfile.ZipInfo("root/link")
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            package.writestr(info, "target")
        with self.assertRaises(FfmpegError):
            self.inspect_bytes(output.getvalue())

    def test_rejects_file_count_expansion_member_ratio_and_crc_abuse(self) -> None:
        content = make_package()
        with self.assertRaises(FfmpegError):
            self.inspect_bytes(content, max_files=1)
        with self.assertRaises(FfmpegError):
            self.inspect_bytes(content, max_expanded_bytes=1)
        with self.assertRaises(FfmpegError):
            self.inspect_bytes(content, max_member_bytes=1)
        compressed = make_package(entries={
            "root/bin/ffmpeg.exe": b"x" * 10000,
            "root/bin/ffprobe.exe": b"y",
            "root/LICENSE": b"z",
        }, compression=zipfile.ZIP_DEFLATED)
        with self.assertRaises(FfmpegError) as error:
            self.inspect_bytes(compressed)
        self.assertEqual(error.exception.code, "UNSAFE_ZIP")

        damaged = bytearray(content)
        with zipfile.ZipFile(io.BytesIO(content)) as package:
            info = package.getinfo("ffmpeg-test/bin/ffmpeg.exe")
            offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        damaged[offset] ^= 0x01
        with self.assertRaises(FfmpegError) as error:
            self.inspect_bytes(bytes(damaged))
        self.assertEqual(error.exception.code, "ZIP_CRC_FAILED")


class ManagedInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        self.package = make_package()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def connector(self, package: bytes | None = None):
        content = self.package if package is None else package
        metadata = json.dumps(release_json(content)).encode()
        return FakeConnector([
            FakeUpstream(metadata),
            FakeUpstream(content, headers={"Content-Length": str(len(content))}),
        ])

    def test_install_is_verified_staged_attributed_and_atomically_selected(self) -> None:
        progress = []
        status, candidate, manifest = install_managed(
            self.paths,
            "portable",
            connector=self.connector(),
            runner=capable_runner,
            progress=progress.append,
            minimum_asset_size=1,
            maximum_asset_size=len(self.package) + 1,
        )
        self.assertEqual(status.state, "ready")
        self.assertTrue(candidate.managed)
        self.assertTrue(candidate.ffmpeg_path.is_file())
        self.assertTrue((candidate.ffmpeg_path.parent.parent / "LICENSE.txt").is_file())
        self.assertTrue((candidate.ffmpeg_path.parent.parent / "SOURCE.txt").is_file())
        self.assertEqual(manifest["verified_digest"], release_json(self.package)["assets"][0]["digest"])
        pointer = json.loads((self.paths.tools_root / "current.json").read_text())
        self.assertNotIn("..", pointer["relative_path"])
        self.assertEqual(progress[-1], 1.0)
        self.assertFalse(list(self.paths.tools_root.glob(".download-*")))
        self.assertFalse(list(self.paths.tools_root.glob(".staging-*")))

    def test_read_only_portable_uses_only_explicit_localappdata_fallback(self) -> None:
        real_probe = __import__("worldmedia_ffmpeg").probe_writable

        def destination_probe(path):
            if Path(path).resolve() == self.paths.tools_root.resolve():
                return False, "Portable downloads/tools directory is not writable."
            return real_probe(path)

        with mock.patch("worldmedia_ffmpeg.probe_writable", side_effect=destination_probe):
            with self.assertRaises(FfmpegError) as blocked:
                install_managed(
                    self.paths, "portable", connector=self.connector(), runner=capable_runner,
                    minimum_asset_size=1, maximum_asset_size=len(self.package) + 1,
                )
            self.assertEqual(blocked.exception.code, "DESTINATION_NOT_WRITABLE")
            status, candidate, _manifest = install_managed(
                self.paths, "LocalAppData", connector=self.connector(), runner=capable_runner,
                minimum_asset_size=1, maximum_asset_size=len(self.package) + 1,
            )
        self.assertEqual(status.source, "LocalAppData")
        self.assertTrue(candidate.ffmpeg_path.is_relative_to(self.paths.state_root))
        self.assertFalse((self.paths.tools_root / "current.json").exists())
        self.assertTrue((self.paths.state_root / "tools" / "ffmpeg" / "current.json").is_file())

    def test_failed_pointer_commit_removes_orphan_and_preserves_current(self) -> None:
        self.paths.tools_root.mkdir(parents=True)
        current = self.paths.tools_root / "current.json"
        current.write_text('{"schema_version":1,"relative_path":"versions/old"}', encoding="utf-8")
        original_atomic = __import__("worldmedia_ffmpeg")._atomic_json

        def fail_pointer(path, value):
            if path.name == "current.json":
                raise OSError("simulated pointer failure")
            return original_atomic(path, value)

        with mock.patch("worldmedia_ffmpeg._atomic_json", side_effect=fail_pointer):
            with self.assertRaises(OSError):
                install_managed(
                    self.paths, "portable", connector=self.connector(), runner=capable_runner,
                    minimum_asset_size=1, maximum_asset_size=len(self.package) + 1,
                )
        self.assertEqual(current.read_text(encoding="utf-8"), '{"schema_version":1,"relative_path":"versions/old"}')
        self.assertEqual(list(self.paths.tools_root.glob("release-*")), [])

    def test_failed_probe_and_cancel_leave_no_staging_or_selection(self) -> None:
        def incapable(command, **kwargs):
            result = capable_runner(command, **kwargs)
            if command[-1] == "-muxers":
                result.stdout = "Muxers:\n E mp3\n"
            return result

        with self.assertRaises(FfmpegError) as error:
            install_managed(
                self.paths, "portable", connector=self.connector(), runner=incapable,
                minimum_asset_size=1, maximum_asset_size=len(self.package) + 1,
            )
        self.assertEqual(error.exception.code, "MISSING_CAPABILITY")
        self.assertFalse((self.paths.tools_root / "current.json").exists())
        self.assertFalse(list(self.paths.tools_root.glob(".staging-*")))

        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(InstallCancelled):
            install_managed(
                self.paths, "portable", connector=self.connector(), runner=capable_runner,
                cancel=cancelled, minimum_asset_size=1, maximum_asset_size=len(self.package) + 1,
            )

    def test_remove_is_destination_limited_and_does_not_touch_other_roots(self) -> None:
        portable_marker = self.paths.tools_root / "marker"
        local_marker = self.paths.state_root / "tools" / "ffmpeg" / "marker"
        outside = self.paths.portable_root.parent / "outside"
        for marker in (portable_marker, local_marker, outside):
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("keep", encoding="utf-8")
        remove_managed(self.paths, "portable")
        self.assertFalse(portable_marker.exists())
        self.assertTrue(local_marker.exists())
        self.assertTrue(outside.exists())
        with self.assertRaises(FfmpegError):
            remove_managed(self.paths, "..")

        with mock.patch("pathlib.Path.is_symlink", return_value=True):
            with self.assertRaises(FfmpegError) as error:
                managed_root(self.paths, "portable")
        self.assertEqual(error.exception.code, "UNSAFE_PATH")

    def test_service_preserves_terminal_install_error_for_status_polling(self) -> None:
        invalid = json.dumps({"not": "a release"}).encode()
        service = FfmpegService(self.paths, connector=FakeConnector([FakeUpstream(invalid)]), runner=capable_runner)
        service.start_install("portable")
        status = service.wait(2)
        self.assertEqual(status.state, "error")
        self.assertEqual(status.error["code"], "INVALID_RELEASE")
        self.assertEqual(service.status().state, "error")

    def test_service_shutdown_reports_whether_install_worker_was_reaped(self) -> None:
        service = FfmpegService(self.paths, connector=self.connector(), runner=capable_runner)
        stopped = threading.Thread(target=service._cancel.wait, daemon=True)
        service._thread = stopped
        stopped.start()
        self.assertTrue(service.shutdown(timeout=1))

        release = threading.Event()
        hung = threading.Thread(target=release.wait, daemon=True)
        service._thread = hung
        hung.start()
        self.assertFalse(service.shutdown(timeout=0))
        release.set()
        hung.join(1)

    def test_windows_scanner_locks_are_retried_for_commit_and_cleanup(self) -> None:
        source = self.paths.tools_root / ".staging-test"
        destination = self.paths.tools_root / "ready"
        source.mkdir(parents=True)
        real_replace = os.replace
        attempts = 0

        def flaky_replace(old, new):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise PermissionError("scanner lock")
            return real_replace(old, new)

        with mock.patch("worldmedia_ffmpeg.os.replace", side_effect=flaky_replace), \
             mock.patch("worldmedia_ffmpeg.threading.Event.wait", return_value=False):
            _replace_directory_with_retry(source, destination)
        self.assertEqual(attempts, 3)
        self.assertTrue(destination.is_dir())

        blocked_source = self.paths.tools_root / ".staging-blocked"
        blocked_destination = self.paths.tools_root / "never-ready"
        blocked_source.mkdir()
        with mock.patch("worldmedia_ffmpeg.os.replace", side_effect=PermissionError("scanner lock")):
            with self.assertRaises(FfmpegError) as error:
                _replace_directory_with_retry(blocked_source, blocked_destination, timeout=0)
        self.assertEqual(error.exception.code, "INSTALL_COMMIT_FAILED")
        self.assertTrue(error.exception.retryable)
        self.assertTrue(blocked_source.is_dir())

        cleanup = self.paths.tools_root / ".staging-cleanup"
        cleanup.mkdir()
        (cleanup / "file").write_bytes(b"x")
        real_rmtree = __import__("shutil").rmtree
        removals = 0

        def flaky_remove(path, **kwargs):
            nonlocal removals
            removals += 1
            if removals < 3:
                raise PermissionError("scanner lock")
            return real_rmtree(path, **kwargs)

        with mock.patch("worldmedia_ffmpeg.shutil.rmtree", side_effect=flaky_remove), \
             mock.patch("worldmedia_ffmpeg.time.sleep"):
            _safe_remove_tree(cleanup, self.paths.tools_root)
        self.assertEqual(removals, 3)
        self.assertFalse(cleanup.exists())


if __name__ == "__main__":
    unittest.main()
