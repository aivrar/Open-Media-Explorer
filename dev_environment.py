"""Explicit E-drive scratch configuration for local tests and build helpers."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LOCAL_CACHE_DIR = ROOT / "build" / "local-cache"


def configure_local_cache() -> Path:
    paths = {
        "TEMP": LOCAL_CACHE_DIR / "temp",
        "TMP": LOCAL_CACHE_DIR / "temp",
        "PIP_CACHE_DIR": LOCAL_CACHE_DIR / "pip",
        "PYINSTALLER_CONFIG_DIR": LOCAL_CACHE_DIR / "pyinstaller",
        "PYTHONPYCACHEPREFIX": LOCAL_CACHE_DIR / "pycache",
    }
    for path in set(paths.values()):
        path.mkdir(parents=True, exist_ok=True)
    os.environ.update({name: str(path) for name, path in paths.items()})
    tempfile.tempdir = str(paths["TEMP"])
    sys.pycache_prefix = str(paths["PYTHONPYCACHEPREFIX"])
    return LOCAL_CACHE_DIR
