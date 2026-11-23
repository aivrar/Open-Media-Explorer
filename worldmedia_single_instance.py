"""One running World Media per data folder.

A second start with the same data folder must not open a second window or a
second server. The first copy creates a Windows named mutex whose name holds a
hash of the normalised data-folder path; a later start that finds the mutex
already there asks the first copy to show its window and exits. Copies with
different data folders (the portable folder, an installed copy, test runs with
their own WORLDMEDIA_STATE_ROOT) get different names and run side by side.

The operating system removes the mutex when the last handle to it closes,
also when a copy crashes or is killed, so a stale lock never blocks a start.

"Show yourself" is a named auto-reset event. The copy with a window waits on
it in one daemon thread (a blocking wait, no polling) and, when it is set,
restores and brings forward its own window. The event carries no data and no
session token; setting it is all another program can do with it. The event
exists only while a copy that holds the folder has a window (it is made after
the mutex is taken and closed when the window closes), so a start that finds
the mutex but no event knows the copy is closing or has no window, and waits
for the folder to become free (see wait_for_folder).

Everything here is a no-op off Windows (claims are always granted).
"""
from __future__ import annotations

import hashlib
import os
import sys
import threading
import time
from typing import Callable

NAME_PREFIX = "Local\\WorldMediaWindows"
ALREADY_RUNNING_EXIT_CODE = 3
# A window start that finds the folder held by a copy with no window to show
# (closing, or windowless) waits this long for it, trying again this often.
FOLDER_WAIT_SECONDS = 15.0
FOLDER_WAIT_STEP_SECONDS = 0.2

_ERROR_ACCESS_DENIED = 5
_ERROR_ALREADY_EXISTS = 183
_EVENT_MODIFY_STATE = 0x0002
_INFINITE = 0xFFFFFFFF
_WAIT_OBJECT_0 = 0
_ASFW_ANY = 0xFFFFFFFF  # (DWORD)-1

_kernel32 = None
_user32 = None


def _windows_api():
    """kernel32/user32 with argument types set (private instances, so other
    modules' use of ctypes.windll is not affected). None off Windows."""

    global _kernel32, _user32
    if os.name != "nt":
        return None
    if _kernel32 is None:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateEventW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
        kernel32.CreateEventW.restype = wintypes.HANDLE
        kernel32.OpenEventW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
        kernel32.OpenEventW.restype = wintypes.HANDLE
        kernel32.SetEvent.argtypes = (wintypes.HANDLE,)
        kernel32.SetEvent.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.WaitForMultipleObjects.argtypes = (
            wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD,
        )
        kernel32.WaitForMultipleObjects.restype = wintypes.DWORD

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.AllowSetForegroundWindow.argtypes = (wintypes.DWORD,)
        user32.AllowSetForegroundWindow.restype = wintypes.BOOL
        user32.WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows.argtypes = (user32.WNDENUMPROC, wintypes.LPARAM)
        user32.EnumWindows.restype = wintypes.BOOL
        user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.IsWindowVisible.argtypes = (wintypes.HWND,)
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
        user32.GetWindow.restype = wintypes.HWND
        user32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        user32.GetClassNameW.restype = ctypes.c_int
        user32.IsIconic.argtypes = (wintypes.HWND,)
        user32.IsIconic.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.ShowWindow.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
        user32.SetForegroundWindow.restype = wintypes.BOOL
        user32.SetWindowPos.argtypes = (wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, ctypes.c_int, wintypes.UINT)
        user32.SetWindowPos.restype = wintypes.BOOL

        class FLASHWINFO(ctypes.Structure):
            _fields_ = (("cbSize", wintypes.UINT), ("hwnd", wintypes.HWND), ("dwFlags", wintypes.DWORD),
                        ("uCount", wintypes.UINT), ("dwTimeout", wintypes.DWORD))

        user32.FLASHWINFO = FLASHWINFO
        user32.FlashWindowEx.argtypes = (ctypes.POINTER(FLASHWINFO),)
        user32.FlashWindowEx.restype = wintypes.BOOL
        _kernel32, _user32 = kernel32, user32
    return _kernel32, _user32


def normalize_data_folder(path: str | os.PathLike) -> str:
    """The data folder as one spelling: absolute, symlinks and ``..`` resolved,
    no trailing separator, and (on Windows) lower case with backslashes."""

    full = os.path.abspath(os.fspath(path))
    try:
        full = os.path.realpath(full)
    except (OSError, ValueError):
        pass
    return os.path.normcase(os.path.normpath(full))


def object_names(data_folder: str | os.PathLike, *, prefix: str = NAME_PREFIX) -> tuple[str, str]:
    """The (mutex, show-event) names for a data folder."""

    digest = hashlib.sha256(normalize_data_folder(data_folder).encode("utf-8")).hexdigest()[:32]
    return f"{prefix}-{digest}-instance", f"{prefix}-{digest}-show"


class InstanceClaim:
    """The result of :func:`claim_data_folder`. ``owned`` is False when another
    copy already runs with this data folder."""

    def __init__(self, owned: bool, mutex=None, event=None) -> None:
        self.owned = owned
        self._mutex = mutex
        self._event = event
        self._stop = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def listen(self, on_show: Callable[[], object]) -> bool:
        """Call ``on_show`` (in a daemon thread) each time another start asks
        this copy to show itself. A request made before this call is delivered
        now. Starts at most one thread; False when there is nothing to wait on."""

        api = _windows_api()
        with self._lock:
            if api is None or self._event is None or self._thread is not None:
                return False
            kernel32 = api[0]
            self._stop = kernel32.CreateEventW(None, True, False, None)
            if not self._stop:
                self._stop = None
                return False
            self._thread = threading.Thread(
                target=self._wait_for_requests, args=(kernel32, self._event, self._stop, on_show),
                name="worldmedia-show-request", daemon=True,
            )
            self._thread.start()
            return True

    @staticmethod
    def _wait_for_requests(kernel32, event, stop, on_show) -> None:
        from ctypes import wintypes

        handles = (wintypes.HANDLE * 2)(event, stop)
        while True:
            result = kernel32.WaitForMultipleObjects(2, handles, False, _INFINITE)
            if result != _WAIT_OBJECT_0:
                return  # stop requested, or the wait failed
            try:
                on_show()
            except Exception as exc:  # never let a show request end the thread
                _note(f"[instance] could not show the window: {exc}")

    def stop_listening(self) -> None:
        """No more show requests (the window is closing): ends the waiting
        thread and closes the show event, so later starts know there is no
        window to show. The folder stays held. Safe to call again."""

        api = _windows_api()
        with self._lock:
            event, stop, thread = self._event, self._stop, self._thread
            self._event = self._stop = None
            self._thread = None
        if api is None:
            return
        kernel32 = api[0]
        stopped = True
        if stop:
            kernel32.SetEvent(stop)
            if thread is not None and thread is not threading.current_thread():
                thread.join(2.0)
                stopped = not thread.is_alive()
        if stopped:
            # A handle is never closed while the thread may still wait on it;
            # if it did not end, the system closes both when the process ends.
            if event:
                kernel32.CloseHandle(event)
            if stop:
                kernel32.CloseHandle(stop)

    def release(self) -> None:
        """Let another copy start with this data folder (call when this copy's
        work is fully done). Safe to call again."""

        self.stop_listening()
        api = _windows_api()
        with self._lock:
            mutex, self._mutex = self._mutex, None
        if api is not None and mutex:
            api[0].CloseHandle(mutex)


def claim_data_folder(data_folder: str | os.PathLike, *, listen: bool = True,
                      prefix: str = NAME_PREFIX) -> InstanceClaim:
    """Claim the data folder for this process.

    ``listen`` (a copy with a window) creates the show-yourself event once the
    folder is held. A mutex that exists but cannot be opened (made by an
    elevated copy or another account) counts as held. If the claim cannot be
    checked at all (no Windows, another API failure) the start goes ahead as
    before."""

    api = _windows_api()
    if api is None:
        return InstanceClaim(True)
    import ctypes

    kernel32 = api[0]
    mutex_name, event_name = object_names(data_folder, prefix=prefix)
    ctypes.set_last_error(0)
    mutex = kernel32.CreateMutexW(None, False, mutex_name)
    error = ctypes.get_last_error()
    if mutex and error == _ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(mutex)
        return InstanceClaim(False)
    if not mutex:
        if error == _ERROR_ACCESS_DENIED:
            return InstanceClaim(False)
        _note(f"[instance] could not create the single-copy lock (error {error})")
        return InstanceClaim(True)
    event = kernel32.CreateEventW(None, False, False, event_name) if listen else None
    return InstanceClaim(True, mutex, event or None)


def wait_for_folder(data_folder: str | os.PathLike, *, timeout: float = FOLDER_WAIT_SECONDS,
                    interval: float = FOLDER_WAIT_STEP_SECONDS, prefix: str = NAME_PREFIX,
                    sleep=time.sleep, clock=time.monotonic) -> tuple[InstanceClaim, str]:
    """For a window start that found the folder held: ask the holder to show
    itself; while it has no window (closing, or windowless), try to take the
    folder every ``interval`` seconds for up to ``timeout``.

    Returns (claim, outcome): "shown" (a holder with a window got the
    request), "owned" (the folder came free and is now held by this process,
    with a show event), or "timeout". Of several starts waiting together one
    takes the folder; the others then reach its show event."""

    deadline = clock() + timeout
    while True:
        if request_show(data_folder, prefix=prefix):
            return InstanceClaim(False), "shown"
        if clock() >= deadline:
            return InstanceClaim(False), "timeout"
        sleep(interval)
        claim = claim_data_folder(data_folder, listen=True, prefix=prefix)
        if claim.owned:
            return claim, "owned"


def request_show(data_folder: str | os.PathLike, *, prefix: str = NAME_PREFIX) -> bool:
    """Ask the copy that holds this data folder to show its window. False when
    it has no window to show (a copy without a window, or one that is closing)
    or its event cannot be opened or set (another account, access denied)."""

    api = _windows_api()
    if api is None:
        return False
    kernel32, user32 = api
    # This start was launched by the user, so it may hand its right to take
    # the foreground to the running copy.
    user32.AllowSetForegroundWindow(_ASFW_ANY)
    handle = kernel32.OpenEventW(_EVENT_MODIFY_STATE, False, object_names(data_folder, prefix=prefix)[1])
    if not handle:
        return False
    try:
        return bool(kernel32.SetEvent(handle))
    finally:
        kernel32.CloseHandle(handle)


def find_own_window(pid: int | None = None) -> int | None:
    """The main top-level window of this process (WinForms, which pywebview
    uses), or another visible unowned top-level window of it; None if none."""

    api = _windows_api()
    if api is None:
        return None
    import ctypes
    from ctypes import wintypes

    user32 = api[1]
    pid = os.getpid() if pid is None else pid
    forms: list[int] = []
    others: list[int] = []

    @user32.WNDENUMPROC
    def visit(hwnd, _lparam):
        owner_pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
        if owner_pid.value != pid or not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, 4):  # GW_OWNER
            return True
        name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, name, 256)
        (forms if name.value.startswith("WindowsForms") else others).append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    found = forms or others
    return found[0] if found else None


def bring_own_window_to_front() -> bool:
    """Restore this process's window if minimised and bring it to the front.
    When Windows refuses the foreground, the window is still raised above
    others (without taking focus) and its taskbar button flashes."""

    api = _windows_api()
    hwnd = find_own_window()
    if api is None or not hwnd:
        return False
    user32 = api[1]
    import ctypes

    user32.ShowWindow(hwnd, 9 if user32.IsIconic(hwnd) else 5)  # SW_RESTORE / SW_SHOW
    if user32.SetForegroundWindow(hwnd):
        return True
    flags = 0x0001 | 0x0002 | 0x0010  # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)  # HWND_TOPMOST
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, flags)  # HWND_NOTOPMOST
    info = user32.FLASHWINFO(ctypes.sizeof(user32.FLASHWINFO), hwnd, 0x2 | 0xC, 0, 0)  # TRAY, until focused
    user32.FlashWindowEx(ctypes.byref(info))
    return False


def _note(message: str) -> None:
    stream = sys.stderr
    if stream is None:  # pythonw and the windowed EXE have no stderr
        return
    try:
        stream.write(message + "\n")
        stream.flush()
    except (OSError, ValueError):
        pass
