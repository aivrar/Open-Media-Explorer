"""Shared by the flash and effect checks (visualizer-flash-check.py,
visualizer-fx-check.py): keeping a long run light on the machine, and
reporting how far it is.

    --low           below-normal priority, for this process and the browser
    --cores=N       only N processor cores (its affinity), the browser too
    --progress=F    a small text file rewritten as each recording ends
                    (recordings done / total, the current one), after
                    the text of CHECK_PROGRESS_PREFIX when set (a driver's
                    own line: which part of a longer run this is)

The processor time of each recording (this process and every browser process
under it) is reported with it as cpu_s. Needs psutil for --low, --cores and
cpu_s; without it they are left out."""

import os
import pathlib
import sys
import time

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None


def options(argv):
    """The check's own arguments, and its limits taken out of them."""
    out = {'low': False, 'cores': 0, 'progress': None}
    rest = []
    for arg in argv:
        if arg == '--low':
            out['low'] = True
        elif arg.startswith('--cores='):
            out['cores'] = int(arg.split('=', 1)[1])
        elif arg.startswith('--progress='):
            out['progress'] = arg.split('=', 1)[1]
        else:
            rest.append(arg)
    return out, rest


def _limit(proc, limits):
    try:
        if limits['low']:
            proc.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == 'win32' else 10)
        if limits['cores']:
            proc.cpu_affinity(list(range(min(limits['cores'], psutil.cpu_count()))))
    except (psutil.Error, OSError, AttributeError):
        pass


class Limits:
    """Applies the limits to this process now (the browser it starts
    inherits them) and to its child processes again after each launch;
    measures processor time per recording; writes the progress file."""

    def __init__(self, limits, total):
        self.limits = limits
        self.total = total
        self.done = 0
        self.started = time.time()
        self.me = psutil.Process() if psutil else None
        if self.me:
            _limit(self.me, limits)
        self._mark = self._cpu()

    def tree(self):
        if not self.me:
            return []
        try:
            return [self.me, *self.me.children(recursive=True)]
        except psutil.Error:
            return [self.me]

    def apply_to_children(self):
        if not self.me:
            return
        for proc in self.tree()[1:]:
            _limit(proc, self.limits)

    def _cpu(self):
        total = 0.0
        for proc in self.tree():
            try:
                t = proc.cpu_times()
                total += t.user + t.system
            except psutil.Error:
                pass
        return total

    def begin(self, label):
        """A recording starts: noted in the progress file."""
        self.apply_to_children()
        self._mark = self._cpu()
        self.write(label)

    def end(self):
        """A recording ended: its processor time (s), or None."""
        self.done += 1
        used = self._cpu() - self._mark if self.me else None
        self.write('')
        return round(used, 2) if used is not None else None

    def write(self, current):
        if not self.limits['progress']:
            return
        minutes = (time.time() - self.started) / 60
        prefix = os.environ.get('CHECK_PROGRESS_PREFIX', '')
        text = (prefix + '\n' if prefix else '') + f'{self.done} / {self.total} recordings done, {minutes:.1f} min\ncurrent: {current or "-"}\n'
        try:
            pathlib.Path(self.limits['progress']).write_text(text)
        except OSError:
            pass
