from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import worldmedia_native


@unittest.skipUnless(os.name == "nt", "Zone.Identifier streams exist only on NTFS")
class UnblockBundledAssembliesTests(unittest.TestCase):
    """Issue #3: a zip extracted by Explorer marks every DLL as downloaded."""

    @staticmethod
    def _mark(path: Path) -> bool:
        try:
            with open(f"{path}:Zone.Identifier", "w", encoding="ascii") as stream:
                stream.write("[ZoneTransfer]\nZoneId=3\n")
        except OSError:
            return False
        return True

    @staticmethod
    def _marked(path: Path) -> bool:
        return os.path.exists(f"{path}:Zone.Identifier")

    def test_only_the_apps_own_net_assemblies_are_unblocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = [
                root / "pythonnet" / "runtime" / "Python.Runtime.dll",
                root / "clr_loader" / "ffi" / "dlls" / "amd64" / "ClrLoader.dll",
                root / "webview" / "lib" / "Microsoft.Web.WebView2.Core.dll",
            ]
            untouched = [
                root / "other_package" / "thing.dll",
                root / "webview" / "lib" / "notes.txt",
            ]
            for path in (*owned, *untouched):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"test")
                if not self._mark(path):
                    self.skipTest("filesystem does not support alternate data streams")

            self.assertEqual(worldmedia_native.unblock_bundled_assemblies(root), len(owned))

            self.assertTrue(all(not self._marked(path) for path in owned))
            self.assertTrue(all(path.read_bytes() == b"test" for path in owned))
            self.assertTrue(all(self._marked(path) for path in untouched))
            # Running again (nothing left to clear) is harmless.
            self.assertEqual(worldmedia_native.unblock_bundled_assemblies(root), 0)

    def test_missing_folders_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(worldmedia_native.unblock_bundled_assemblies(Path(directory) / "absent"), 0)


if __name__ == "__main__":
    unittest.main()
