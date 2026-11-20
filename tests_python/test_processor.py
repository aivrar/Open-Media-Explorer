import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_processor as processor  # noqa: E402
from worldmedia_processor import ProcessorUse, tree_of  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class ProcessorUseTests(unittest.TestCase):
    def make(self, samples, cpus=4):
        clock = FakeClock()
        queue = list(samples)
        use = ProcessorUse(lambda: queue.pop(0), clock=clock, cpus=cpus)
        return use, clock

    def test_the_first_reading_only_sets_the_start(self):
        use, clock = self.make([{(1, 5): 10.0}, {(1, 5): 12.0}])
        self.assertEqual(use.reading(), {"available": True, "share": None, "cpus": 4, "processes": 1})
        clock.now += 2.0
        # 2 processor seconds in 2 s over 4 processors: a quarter.
        self.assertEqual(use.reading()["share"], 0.25)

    def test_the_whole_tree_counts_and_a_reused_id_is_not_mixed_up(self):
        use, clock = self.make([
            {(1, 5): 10.0, (7, 6): 3.0, (9, 1): 50.0},
            # Process 9 ended and its id came back as a new process: only the
            # times seen in both readings count.
            {(1, 5): 11.0, (7, 6): 4.0, (9, 2): 0.5},
        ], cpus=2)
        use.reading()
        clock.now += 1.0
        self.assertEqual(use.reading()["share"], 1.0)

    def test_a_long_pause_starts_afresh_and_shares_stay_between_0_and_1(self):
        use, clock = self.make([{(1, 5): 0.0}, {(1, 5): 100.0}, {(1, 5): 1000.0}], cpus=1)
        use.reading()
        clock.now += processor.STALE_AFTER_SECONDS + 1
        self.assertIsNone(use.reading()["share"])
        clock.now += 1.0
        self.assertEqual(use.reading()["share"], 1.0)

    def test_readings_close_together_reuse_the_last_answer(self):
        calls = []

        def sampler():
            calls.append(1)
            return {(1, 5): float(len(calls))}

        clock = FakeClock()
        use = ProcessorUse(sampler, clock=clock, cpus=1)
        use.reading()
        clock.now += processor.MIN_INTERVAL_SECONDS / 2
        use.reading()
        self.assertEqual(len(calls), 1)

    def test_no_reading_where_none_is_available_and_a_failing_sampler_never_raises(self):
        self.assertEqual(ProcessorUse(None, use_default=False).reading()["available"], False)

        def broken():
            raise OSError("access denied")

        self.assertIsNone(ProcessorUse(broken, cpus=1).reading()["share"])

    def test_the_tree_is_every_descendant_once(self):
        children = {1: [2, 3], 2: [4], 4: [1], 3: [0]}
        created = {1: 10, 2: 11, 3: 12, 4: 13}
        self.assertEqual(tree_of(1, children, created.get), [1, 2, 3, 4])

    def test_a_reused_parent_id_does_not_pull_in_an_unrelated_process(self):
        # Process 50 (an old program, started at 5) was a child of a process
        # 20 that ended long ago; the id 20 now belongs to the app's own new
        # helper (started at 30). 50 names 20 as its parent but is older than
        # it: not the app's.
        children = {1: [20], 20: [50, 21]}
        created = {1: 10, 20: 30, 21: 31, 50: 5}
        self.assertEqual(tree_of(1, children, created.get), [1, 20, 21])
        # A process whose start cannot be read is left out, with what is
        # below it.
        self.assertEqual(tree_of(1, {1: [2], 2: [3]}, {1: 1, 3: 3}.get), [1])

    def test_the_walk_is_bounded(self):
        wide = {1: list(range(2, 500))}
        self.assertEqual(len(tree_of(1, wide, lambda pid: pid)), processor.MAX_TREE_PROCESSES)
        deep = {pid: [pid + 1] for pid in range(1, 100)}
        self.assertEqual(tree_of(1, deep, lambda pid: pid), list(range(1, processor.MAX_TREE_DEPTH + 2)))

    def test_a_clock_that_goes_back_gives_no_share_and_starts_afresh(self):
        use, clock = self.make([{(1, 5): 0.0}, {(1, 5): 1.0}, {(1, 5): 1.5}, {(1, 5): 2.5}], cpus=1)
        use.reading()
        clock.now += 1.0
        self.assertEqual(use.reading()["share"], 1.0)
        clock.now -= 0.2  # back, by less than the shortest interval
        self.assertIsNone(use.reading()["share"])
        # Afresh: the next reading only sets the start, the one after measures.
        self.assertIsNone(use.reading()["share"])
        clock.now += 1.0
        self.assertEqual(use.reading()["share"], 1.0)

    def test_nothing_runs_between_requests(self):
        source = (ROOT / "worldmedia_processor.py").read_text(encoding="utf-8")
        self.assertNotIn("Thread(", source)
        self.assertNotIn("Timer(", source)
        server = (ROOT / "worldmedia_server.py").read_text(encoding="utf-8")
        self.assertIn('if path == "/api/v1/system/processor-use":', server)

    @unittest.skipUnless(sys.platform == "win32", "Windows only")
    def test_this_process_can_be_read_on_windows(self):
        times = processor.default_sampler()()
        self.assertTrue(times)
        self.assertTrue(all(seconds >= 0 for seconds in times.values()))


if __name__ == "__main__":
    unittest.main()
