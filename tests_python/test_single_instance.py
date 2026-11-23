"""One running copy per data folder (worldmedia_single_instance)."""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import string
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import worldmedia_native
import worldmedia_single_instance as single

ROOT = Path(__file__).resolve().parents[1]


def _prefix() -> str:
    # Each test gets names nothing else uses.
    return f"Local\\WorldMediaWindowsTest-{uuid.uuid4().hex}"


class NormalisationTests(unittest.TestCase):
    def test_spellings_of_one_folder_are_the_same(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = os.path.join(directory, "WorldMediaWindows-data")
            os.mkdir(base)
            spellings = [base, base + os.sep, base + os.sep + os.sep,
                         os.path.join(base, "sub", ".."), os.path.join(base, ".")]
            if os.name == "nt":
                spellings += [base.upper(), base.lower() + "\\", base.replace("\\", "/") + "/"]
            expected = single.normalize_data_folder(base)
            for spelling in spellings:
                with self.subTest(spelling=spelling):
                    self.assertEqual(single.normalize_data_folder(spelling), expected)
                    self.assertEqual(single.object_names(spelling), single.object_names(base))

    def test_relative_path_is_made_absolute(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            here = os.getcwd()
            os.chdir(directory)
            try:
                self.assertEqual(single.normalize_data_folder("data"),
                                 single.normalize_data_folder(os.path.join(directory, "data")))
            finally:
                os.chdir(here)

    def test_different_folders_get_different_names(self) -> None:
        first = single.object_names(r"C:\Apps\WorldMedia\WorldMediaWindows-data")
        second = single.object_names(r"C:\Apps\WorldMedia2\WorldMediaWindows-data")
        self.assertNotEqual(first, second)
        self.assertNotEqual(first[0], first[1])
        for name in (*first, *second):
            self.assertTrue(name.startswith("Local\\WorldMediaWindows-"))
            self.assertNotIn("Apps", name)  # only a hash of the path, no path


@unittest.skipUnless(os.name == "nt", "named mutexes and events are Windows objects")
class ClaimTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prefix = _prefix()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name) / "WorldMediaWindows-data"
        self.claims: list[single.InstanceClaim] = []

    def tearDown(self) -> None:
        for claim in self.claims:
            claim.release()

    def claim(self, folder=None, **kwargs) -> single.InstanceClaim:
        claim = single.claim_data_folder(self.folder if folder is None else folder, prefix=self.prefix, **kwargs)
        self.claims.append(claim)
        return claim

    def test_second_claim_for_the_same_folder_is_refused(self) -> None:
        self.assertTrue(self.claim().owned)
        self.assertFalse(self.claim().owned)
        self.assertFalse(self.claim(listen=False).owned)
        # Another spelling of the same folder is the same folder.
        self.assertFalse(self.claim(str(self.folder).upper() + "\\").owned)

    def test_claim_does_not_create_the_folder(self) -> None:
        self.assertTrue(self.claim().owned)
        self.assertFalse(self.folder.exists())

    def test_different_folders_are_independent(self) -> None:
        self.assertTrue(self.claim().owned)
        self.assertTrue(self.claim(self.folder.parent / "other-data").owned)
        # The real name prefix is separate from this test's prefix too.
        real = single.claim_data_folder(self.folder, listen=False)
        try:
            self.assertTrue(real.owned)
        finally:
            real.release()

    def test_release_frees_the_folder_and_can_be_repeated(self) -> None:
        first = self.claim()
        first.release()
        first.release()
        self.assertTrue(self.claim().owned)

    def test_a_refused_claim_does_not_keep_the_folder(self) -> None:
        first = self.claim()
        refused = self.claim()
        self.assertFalse(refused.owned)
        first.release()
        self.assertTrue(self.claim().owned)

    def test_show_request_reaches_the_waiting_copy(self) -> None:
        first = self.claim()
        shown = threading.Event()
        self.assertTrue(first.listen(shown.set))
        self.assertFalse(first.listen(shown.set))  # one thread only
        self.assertTrue(single.request_show(self.folder, prefix=self.prefix))
        self.assertTrue(shown.wait(5))
        shown.clear()
        self.assertTrue(single.request_show(str(self.folder).lower(), prefix=self.prefix))
        self.assertTrue(shown.wait(5))

    def test_a_request_made_before_listening_is_kept(self) -> None:
        # Two starts racing: the second asks before the first has a window.
        first = self.claim()
        self.assertFalse(self.claim().owned)
        self.assertTrue(single.request_show(self.folder, prefix=self.prefix))
        shown = threading.Event()
        first.listen(shown.set)
        self.assertTrue(shown.wait(5))

    def test_a_copy_without_a_window_gets_no_show_request(self) -> None:
        first = self.claim(listen=False)
        self.assertTrue(first.owned)
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))
        self.assertFalse(first.listen(lambda: None))

    def test_nobody_running_means_no_show_request(self) -> None:
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))

    def test_release_ends_the_waiting_thread(self) -> None:
        first = self.claim()
        first.listen(lambda: None)
        thread = first._thread
        self.assertTrue(thread.is_alive())
        first.release()
        self.assertFalse(thread.is_alive())
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))

    def test_a_failing_show_does_not_end_the_wait(self) -> None:
        first = self.claim()
        calls = []
        done = threading.Event()

        def on_show():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("no window yet")
            done.set()

        first.listen(on_show)
        with redirect_stderr(io.StringIO()):
            single.request_show(self.folder, prefix=self.prefix)
            deadline = time.monotonic() + 5
            while not calls and time.monotonic() < deadline:
                time.sleep(0.01)
            single.request_show(self.folder, prefix=self.prefix)
            self.assertTrue(done.wait(5))

    def test_racing_claims_give_exactly_one_owner(self) -> None:
        results: list[single.InstanceClaim] = []
        lock = threading.Lock()
        start = threading.Barrier(8)

        def race():
            start.wait()
            claim = single.claim_data_folder(self.folder, prefix=self.prefix)
            with lock:
                results.append(claim)

        threads = [threading.Thread(target=race) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.claims.extend(results)
        self.assertEqual(sum(1 for claim in results if claim.owned), 1)

    def test_a_killed_copy_does_not_block_the_next_start(self) -> None:
        code = (
            "import sys, worldmedia_single_instance as s\n"
            "c = s.claim_data_folder(sys.argv[1], prefix=sys.argv[2])\n"
            "print('owned' if c.owned else 'refused', flush=True)\n"
            "sys.stdin.read()\n"
        )
        child = subprocess.Popen(
            [sys.executable, "-c", code, str(self.folder), self.prefix], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "owned")
            self.assertFalse(self.claim().owned)
            child.kill()
            child.wait(10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(10)
            child.stdin.close()
            child.stdout.close()
        self.assertTrue(self.claim().owned)

    def test_no_window_to_bring_forward_is_harmless(self) -> None:
        # This test process has no top-level window of its own.
        if single.find_own_window() is None:
            self.assertFalse(single.bring_own_window_to_front())

    # A copy whose window has closed keeps the folder until shutdown is done.

    def closing_copy(self) -> single.InstanceClaim:
        holder = self.claim()
        holder.listen(lambda: None)
        holder.stop_listening()
        return holder

    def test_stop_listening_keeps_the_folder_but_ends_show_requests(self) -> None:
        holder = self.claim()
        holder.listen(lambda: None)
        thread = holder._thread
        holder.stop_listening()
        holder.stop_listening()
        self.assertFalse(thread.is_alive())
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))
        self.assertFalse(self.claim().owned)
        self.assertFalse(holder.listen(lambda: None))
        holder.release()
        self.assertTrue(self.claim().owned)

    def wait(self, **kwargs):
        kwargs.setdefault("timeout", 10)
        kwargs.setdefault("interval", 0.05)
        claim, outcome = single.wait_for_folder(self.folder, prefix=self.prefix, **kwargs)
        self.claims.append(claim)
        return claim, outcome

    def test_wait_shows_a_running_window_at_once(self) -> None:
        holder = self.claim()
        shown = threading.Event()
        holder.listen(shown.set)
        claim, outcome = self.wait(sleep=mock.Mock(side_effect=AssertionError("waited")))
        self.assertEqual((claim.owned, outcome), (False, "shown"))
        self.assertTrue(shown.wait(5))

    def test_wait_takes_the_folder_once_a_closing_copy_is_done(self) -> None:
        holder = self.closing_copy()
        timer = threading.Timer(0.3, holder.release)
        timer.start()
        self.addCleanup(timer.cancel)
        claim, outcome = self.wait()
        self.assertEqual((claim.owned, outcome), (True, "owned"))
        # The new owner has a show event for later starts.
        shown = threading.Event()
        claim.listen(shown.set)
        self.assertTrue(single.request_show(self.folder, prefix=self.prefix))
        self.assertTrue(shown.wait(5))

    def test_wait_gives_up_quietly_when_the_folder_stays_held(self) -> None:
        self.claim(listen=False)  # a windowless copy that keeps running
        now = [0.0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        claim, outcome = self.wait(timeout=1.0, interval=0.2, sleep=sleep, clock=lambda: now[0])
        self.assertEqual((claim.owned, outcome), (False, "timeout"))
        self.assertEqual(len(sleeps), 5)
        self.assertFalse(self.claim().owned)  # still held by the other copy

    def test_two_starts_waiting_on_a_closing_copy_end_with_one_window(self) -> None:
        holder = self.closing_copy()
        results = []
        lock = threading.Lock()

        def start():
            result = self.wait()
            with lock:
                results.append(result)

        threads = [threading.Thread(target=start) for _ in range(2)]
        for thread in threads:
            thread.start()
        time.sleep(0.3)
        holder.release()
        for thread in threads:
            thread.join(15)
        self.assertEqual(sorted(outcome for _claim, outcome in results), ["owned", "shown"])
        owner = next(claim for claim, outcome in results if outcome == "owned")
        shown = threading.Event()
        owner.listen(shown.set)  # the other start's request was kept for it
        self.assertTrue(shown.wait(5))

    def test_wait_reaches_a_start_that_took_the_folder_first(self) -> None:
        holder = self.closing_copy()
        third = []

        def sleep(_seconds):
            if not third:
                holder.release()
                third.append(self.claim())

        claim, outcome = self.wait(sleep=sleep)
        self.assertTrue(third[0].owned)
        self.assertEqual((claim.owned, outcome), (False, "shown"))
        shown = threading.Event()
        third[0].listen(shown.set)
        self.assertTrue(shown.wait(5))


def _create_denied(kind: str, name: str):
    """A named mutex or event that nobody may open (empty DACL), as one made by
    an elevated copy or another account looks to this process; None if it
    cannot be made here."""

    import ctypes
    from ctypes import wintypes

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = (("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                    ("bInheritHandle", wintypes.BOOL))

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    convert = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p)
    convert.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateEventW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateEventW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    descriptor = ctypes.c_void_p()
    if not convert("D:", 1, ctypes.byref(descriptor), None):
        return None
    try:
        attributes = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), descriptor, False)
        if kind == "mutex":
            handle = kernel32.CreateMutexW(ctypes.byref(attributes), False, name)
        else:
            handle = kernel32.CreateEventW(ctypes.byref(attributes), False, False, name)
    finally:
        kernel32.LocalFree(descriptor)
    if not handle:
        return None
    return lambda: kernel32.CloseHandle(handle)


@unittest.skipUnless(os.name == "nt", "named mutexes and events are Windows objects")
class AccessDeniedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prefix = _prefix()
        self.folder = Path(tempfile.gettempdir()) / f"worldmedia-denied-{uuid.uuid4().hex}"
        self.mutex_name, self.event_name = single.object_names(self.folder, prefix=self.prefix)

    def test_a_mutex_this_process_may_not_open_counts_as_held(self) -> None:
        close = _create_denied("mutex", self.mutex_name)
        if close is None:
            self.skipTest("could not make a locked mutex here")
        self.addCleanup(close)
        claim = single.claim_data_folder(self.folder, prefix=self.prefix)
        self.addCleanup(claim.release)
        self.assertFalse(claim.owned)
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))

    def test_an_event_this_process_may_not_open_is_no_show(self) -> None:
        close = _create_denied("event", self.event_name)
        if close is None:
            self.skipTest("could not make a locked event here")
        self.addCleanup(close)
        self.assertFalse(single.request_show(self.folder, prefix=self.prefix))


def _free_drive_letter() -> str | None:
    for letter in reversed(string.ascii_uppercase[12:]):  # M..Z
        if not os.path.exists(f"{letter}:\\"):
            return letter
    return None


@unittest.skipUnless(os.name == "nt" and shutil.which("subst"), "subst drives are a Windows feature")
class SubstDriveTests(unittest.TestCase):
    def test_a_folder_reached_through_a_subst_drive_is_the_same_folder(self) -> None:
        letter = _free_drive_letter()
        if letter is None:
            self.skipTest("no free drive letter")
        with tempfile.TemporaryDirectory() as directory:
            os.mkdir(os.path.join(directory, "data"))
            made = subprocess.run(["subst", f"{letter}:", directory], capture_output=True, text=True)
            if made.returncode != 0:
                self.skipTest(f"subst failed: {made.stdout.strip()} {made.stderr.strip()}")
            try:
                for tail in ("data", os.path.join("data", "not-made-yet")):
                    with self.subTest(tail=tail):
                        self.assertEqual(single.normalize_data_folder(f"{letter}:\\{tail}"),
                                         single.normalize_data_folder(os.path.join(directory, tail)))
            finally:
                subprocess.run(["subst", f"{letter}:", "/D"], capture_output=True, text=True)


@unittest.skipUnless(os.name == "nt", "named mutexes are Windows objects")
class LauncherTests(unittest.TestCase):
    """worldmedia_native.main() with the data folder already in use."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name) / "state"

    def hold(self, *, listen: bool) -> single.InstanceClaim:
        holder = single.claim_data_folder(self.state, listen=listen)
        self.addCleanup(holder.release)
        self.assertTrue(holder.owned)
        return holder

    def run_main(self, *patches, **environment):
        values = {"WORLDMEDIA_STATE_ROOT": str(self.state), "WORLDMEDIA_PORTABLE_ROOT": self.directory.name}
        values.update(environment)
        environ = {key: value for key, value in os.environ.items() if key != "WORLDMEDIA_NO_BROWSER"}
        environ.update(values)
        errors = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, environ, clear=True))
            stack.enter_context(mock.patch.object(worldmedia_native, "migrate_legacy_state",
                                                  side_effect=AssertionError("migrated")))
            stack.enter_context(mock.patch.object(worldmedia_native, "ensure_state_directories",
                                                  side_effect=AssertionError("wrote state")))
            for patch in patches:
                stack.enter_context(patch)
            stack.enter_context(redirect_stderr(errors))
            code = worldmedia_native.main()
        return code, errors.getvalue()

    @staticmethod
    def quick_wait(data_folder, **kwargs):
        return single.wait_for_folder(data_folder, timeout=0.4, interval=0.05)

    def test_window_start_brings_the_running_window_forward_and_exits(self) -> None:
        holder = self.hold(listen=True)
        shown = threading.Event()
        holder.listen(shown.set)
        code, errors = self.run_main(mock.patch.object(worldmedia_native, "_run",
                                                       side_effect=AssertionError("started")))
        self.assertEqual((code, errors), (0, ""))
        self.assertTrue(shown.wait(5))
        self.assertFalse(self.state.exists())

    def test_window_start_ends_quietly_when_the_folder_stays_held(self) -> None:
        self.hold(listen=False)
        code, errors = self.run_main(
            mock.patch.object(worldmedia_native, "wait_for_folder", side_effect=self.quick_wait),
            mock.patch.object(worldmedia_native, "_run", side_effect=AssertionError("started")))
        self.assertEqual((code, errors), (0, ""))
        self.assertFalse(self.state.exists())

    def test_window_start_takes_over_once_a_closing_copy_is_done(self) -> None:
        holder = self.hold(listen=True)
        holder.stop_listening()  # its window has closed; shutdown still running
        timer = threading.Timer(0.2, holder.release)
        timer.start()
        self.addCleanup(timer.cancel)
        seen = []

        def run(paths, instance, *, headless):
            seen.append((instance.owned, headless, single.request_show(self.state)))
            return 5

        code, _errors = self.run_main(
            mock.patch.object(worldmedia_native, "wait_for_folder", side_effect=self.quick_wait),
            mock.patch.object(worldmedia_native, "_run", side_effect=run))
        self.assertEqual(code, 5)
        self.assertEqual(seen, [(True, False, True)])
        again = single.claim_data_folder(self.state, listen=False)  # given back at the end
        self.addCleanup(again.release)
        self.assertTrue(again.owned)

    def test_windowless_start_refuses_with_a_message_and_exit_code(self) -> None:
        for listen in (True, False):
            with self.subTest(running_copy_has_window=listen):
                holder = self.hold(listen=listen)
                code, errors = self.run_main(
                    mock.patch.object(worldmedia_native, "wait_for_folder",
                                      side_effect=AssertionError("waited")),
                    WORLDMEDIA_NO_BROWSER="1")
                holder.release()
                self.assertEqual(code, single.ALREADY_RUNNING_EXIT_CODE)
                self.assertNotEqual(code, 0)
                self.assertIn("already running", errors)
                self.assertFalse(self.state.exists())

    def test_another_data_folder_is_not_refused(self) -> None:
        self.hold(listen=True)
        other = Path(self.directory.name) / "other-state"
        code, _errors = self.run_main(
            mock.patch.object(worldmedia_native, "_run", return_value=7),
            mock.patch.object(worldmedia_native, "wait_for_folder", side_effect=AssertionError("waited")),
            WORLDMEDIA_STATE_ROOT=str(other))
        self.assertEqual(code, 7)
        # The claim is given back when the copy ends.
        again = single.claim_data_folder(other, listen=False)
        try:
            self.assertTrue(again.owned)
        finally:
            again.release()


if __name__ == "__main__":
    unittest.main()
