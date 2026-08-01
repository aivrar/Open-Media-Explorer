"""Deterministic clock and process doubles used by capture/job tests."""
from __future__ import annotations

import io
from collections.abc import Iterable


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = float(start)
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("sleep duration cannot be negative")
        self.sleeps.append(seconds)
        self.now += seconds

    def advance(self, seconds: float) -> None:
        self.sleep(seconds)


class FakeProcess:
    def __init__(self, progress: Iterable[str] = (), returncode: int = 0) -> None:
        self.stdout = io.StringIO("".join(f"{line.rstrip()}\n" for line in progress))
        self.stderr = io.StringIO()
        self._planned_returncode = returncode
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self.returncode is None:
            self.returncode = self._planned_returncode
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class FakeProcessFactory:
    def __init__(self, processes: Iterable[FakeProcess]) -> None:
        self._processes = iter(processes)
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args: object, **kwargs: object) -> FakeProcess:
        self.calls.append((args, kwargs))
        return next(self._processes)
