"""Initialize workspace-local scratch storage before unittest discovery."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from dev_environment import configure_local_cache


CACHE_ROOT = configure_local_cache()


class TestEnvironmentTests(unittest.TestCase):
    def test_python_scratch_storage_is_workspace_local(self) -> None:
        self.assertEqual(Path(tempfile.gettempdir()).resolve(), CACHE_ROOT / "temp")
        self.assertEqual(Path(os.environ["PIP_CACHE_DIR"]).resolve(), CACHE_ROOT / "pip")


if __name__ == "__main__":
    unittest.main()
