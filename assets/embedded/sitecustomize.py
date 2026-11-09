"""Start World Media when the isolated embedded Python runtime initializes."""

from worldmedia_native import main


# The signed pythonw.exe launcher has no script argument.  The embedded
# runtime imports ``sitecustomize`` after its restricted paths are configured,
# so this is the portable distribution's explicit application entry point.
# Exit here: returning would let the launcher fall through to an interactive
# prompt with no console after the window closes or fails to start.
_code = main()
try:
    import sys

    sys.stdout.flush()
    sys.stderr.flush()
except Exception:
    pass
import os

os._exit(_code if isinstance(_code, int) else 0)
