from __future__ import annotations

import unittest

from tests_python.fakes import FakeClock, FakeProcess, FakeProcessFactory


class FakeSeamTests(unittest.TestCase):
    def test_clock_advances_without_wall_time(self) -> None:
        clock = FakeClock(10)
        clock.sleep(1.5)
        clock.advance(2.5)
        self.assertEqual(clock.monotonic(), 14)
        self.assertEqual(clock.sleeps, [1.5, 2.5])

    def test_process_progress_completion_and_cancellation(self) -> None:
        completed = FakeProcess(["frame=1", "progress=end"])
        cancelled = FakeProcess()
        factory = FakeProcessFactory([completed, cancelled])

        first = factory(["ffmpeg", "-progress", "pipe:1"])
        self.assertEqual(first.stdout.read().splitlines(), ["frame=1", "progress=end"])
        self.assertEqual(first.wait(), 0)

        second = factory(["ffmpeg", "-i", "relay"])
        second.terminate()
        self.assertTrue(second.terminated)
        self.assertEqual(second.poll(), -15)
        self.assertEqual(len(factory.calls), 2)


if __name__ == "__main__":
    unittest.main()
