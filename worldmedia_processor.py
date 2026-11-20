"""How much of the processor the app uses, read only when the page asks.

The app is this process and everything it started (on Windows: the WebView2
browser, renderer, GPU and audio processes that draw the window and play the
sound). A reading adds up the processor time of that process tree with the
Windows API (ctypes, no extra package) and compares it with the previous
reading: the share is that time over the wall-clock time between the two
readings and the number of logical processors, from 0 (idle) to 1 (every
processor busy).

Nothing runs between requests: there is no thread and no timer here. The
page asks (GET /api/v1/system/processor-use) only while something that steers
by the budget is active (the Visualizer at Balanced or High, see
src/lib/processor-budget.js), every few seconds. One reading lists the
processes once (a Toolhelp snapshot) and opens the app's own processes to read
their times: on the order of a millisecond.

The first reading, or one after a long pause, only sets the starting point
and reports no share (None). Processes that started or ended between two
readings count only for the time seen in both (a process is known by its id
and its start time, so a reused id is never mixed up).
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Callable, Dict, Optional, Tuple

# A previous reading older than this is no starting point (a long pause, the
# Visualizer was closed): the next reading starts afresh.
STALE_AFTER_SECONDS = 30.0
# Readings closer together than this are answered with the last share.
MIN_INTERVAL_SECONDS = 0.5
# The most processes, and levels below the app, counted as the app's own
# (the app, its window's WebView2 processes and their helpers are far fewer).
MAX_TREE_PROCESSES = 64
MAX_TREE_DEPTH = 6

ProcessKey = Tuple[int, int]  # (process id, start time)
Sampler = Callable[[], Optional[Dict[ProcessKey, float]]]


def _windows_tree_times(root_pid: int) -> Optional[Dict[ProcessKey, float]]:
    """Processor seconds (user + kernel) of `root_pid` and its descendants, by
    (pid, start time); None when they cannot be read."""

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    TH32CS_SNAPPROCESS = 0x00000002
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snapshot or snapshot == INVALID_HANDLE_VALUE:
        return None
    children: Dict[int, list] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            children.setdefault(int(entry.th32ParentProcessID), []).append(int(entry.th32ProcessID))
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)

    def filetime(value: wintypes.FILETIME) -> int:
        return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)

    # pid -> (created, processor seconds), or None: read once per process.
    read: Dict[int, Optional[Tuple[int, float]]] = {}

    def times_of(pid: int) -> Optional[Tuple[int, float]]:
        if pid in read:
            return read[pid]
        read[pid] = None
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None  # ended meanwhile, or not ours to read
        try:
            created, ended, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(ended),
                                        ctypes.byref(kernel), ctypes.byref(user)):
                # FILETIME counts 100 ns steps.
                read[pid] = (filetime(created), (filetime(kernel) + filetime(user)) / 10_000_000)
        finally:
            kernel32.CloseHandle(handle)
        return read[pid]

    def created_of(pid: int) -> Optional[int]:
        found = times_of(pid)
        return None if found is None else found[0]

    times: Dict[ProcessKey, float] = {}
    for pid in tree_of(root_pid, children, created_of):
        found = times_of(pid)
        if found is not None:
            times[(pid, found[0])] = found[1]
    return times


def tree_of(root_pid: int, children: Dict[int, list], created: Callable[[int], Optional[int]]) -> list:
    """`root_pid` and the processes below it in `children` (parent -> ids).

    Process ids are reused, and a snapshot gives only each process's parent
    id: a process whose parent ended may name an id a later, unrelated
    process now has. So a child counts only when `created(pid)` says it
    started no earlier than its parent (a reused parent id belongs to a
    younger process than the "child"); one whose start cannot be read is
    left out. Each id is visited once, and the walk stops at
    MAX_TREE_PROCESSES processes and MAX_TREE_DEPTH levels."""

    seen = {root_pid}
    order = [(root_pid, 0)]
    at = 0
    while at < len(order) and len(order) < MAX_TREE_PROCESSES:
        parent, depth = order[at]
        at += 1
        if depth >= MAX_TREE_DEPTH:
            continue
        parent_created = created(parent)
        if parent_created is None:
            continue
        for child in children.get(parent, ()):
            if child in seen or child == 0:
                continue
            child_created = created(child)
            if child_created is None or child_created < parent_created:
                continue
            seen.add(child)
            order.append((child, depth + 1))
            if len(order) >= MAX_TREE_PROCESSES:
                break
    return [pid for pid, _ in order]


def default_sampler() -> Optional[Sampler]:
    """The sampler for this system, or None where none is available."""

    if sys.platform != "win32":
        return None
    root = os.getpid()
    return lambda: _windows_tree_times(root)


class ProcessorUse:
    """The app's share of the processor between two readings."""

    def __init__(self, sampler: Optional[Sampler] = None, *, clock: Callable[[], float] = time.monotonic,
                 cpus: Optional[int] = None, use_default: bool = True) -> None:
        self._sampler = sampler if sampler is not None else (default_sampler() if use_default else None)
        self._clock = clock
        self._cpus = max(1, int(cpus or os.cpu_count() or 1))
        self._lock = threading.Lock()
        self._last: Optional[Tuple[float, Dict[ProcessKey, float]]] = None
        self._share: Optional[float] = None

    def reading(self) -> dict:
        """{"available", "share" (0..1 or None), "cpus", "processes"}."""

        if self._sampler is None:
            return {"available": False, "share": None, "cpus": self._cpus, "processes": 0}
        with self._lock:
            now = self._clock()
            if self._last is not None and now <= self._last[0]:
                # The clock went back (or stood still): no share from the
                # old reading; the next reading starts afresh.
                self._last = None
                self._share = None
                return self._answer(0)
            if self._last is not None and now - self._last[0] < MIN_INTERVAL_SECONDS:
                return self._answer(len(self._last[1]))
            try:
                sample = self._sampler()
            except Exception:  # noqa: BLE001 - a reading never fails a request
                sample = None
            if not sample:
                self._last = None
                self._share = None
                return self._answer(0)
            previous = self._last
            self._last = (now, sample)
            if previous is None or now - previous[0] > STALE_AFTER_SECONDS or now <= previous[0]:
                self._share = None
                return self._answer(len(sample))
            used = 0.0
            for key, seconds in sample.items():
                before = previous[1].get(key)
                if before is not None and seconds >= before:
                    used += seconds - before
            share = used / ((now - previous[0]) * self._cpus)
            self._share = max(0.0, min(1.0, share))
            return self._answer(len(sample))

    def _answer(self, processes: int) -> dict:
        share = None if self._share is None else round(self._share, 4)
        return {"available": True, "share": share, "cpus": self._cpus, "processes": processes}


PROCESSOR_USE = ProcessorUse()
