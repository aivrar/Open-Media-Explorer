from __future__ import annotations

import unittest

import build_single_exe


class SingleExeBuildTests(unittest.TestCase):
    def test_spec_contains_current_frontend_icon_and_native_webview_loaders(self) -> None:
        spec = build_single_exe.render_spec()
        self.assertIn(repr(str(build_single_exe.FRONTEND_PATH)), spec)
        self.assertIn(repr(str(build_single_exe.ICON_PATH)), spec)
        self.assertIn("webview.platforms.winforms", spec)
        self.assertIn("webview.platforms.edgechromium", spec)
        for module in (
            "webview.platforms.android",
            "webview.platforms.cef",
            "webview.platforms.cocoa",
            "webview.platforms.gtk",
            "webview.platforms.mshtml",
            "webview.platforms.qt",
        ):
            self.assertIn(module, spec)
        self.assertIn("excludes=webview_excludes", spec)
        self.assertIn("collect_all('pythonnet')", spec)
        self.assertIn("collect_all('clr_loader')", spec)
        self.assertIn("copy_metadata('pywebview')", spec)
        self.assertIn("copy_metadata('defusedxml')", spec)
        self.assertNotIn("collect_all('defusedxml')", spec)
        self.assertNotIn("defusedxml.lxml", spec)
        self.assertIn("'defusedxml.ElementTree'", spec)

    def test_single_exe_is_windowed_and_does_not_use_upx(self) -> None:
        spec = build_single_exe.render_spec()
        self.assertIn("console=False", spec)
        self.assertIn("upx=False", spec)
        self.assertIn("name='WorldMediaWindows'", spec)
        self.assertEqual(
            build_single_exe.OUTPUT_PATH,
            build_single_exe.ROOT / "dist" / "WorldMediaWindows.exe",
        )


if __name__ == "__main__":
    unittest.main()
