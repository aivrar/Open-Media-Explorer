from __future__ import annotations

import re
import unittest
from pathlib import Path
from unittest import mock

import worldmedia_theme
from worldmedia_theme import (
    DWMWA_BORDER_COLOR,
    DWMWA_CAPTION_COLOR,
    DWMWA_COLOR_DEFAULT,
    DWMWA_TEXT_COLOR,
    DWMWA_USE_IMMERSIVE_DARK_MODE,
    NATIVE_THEME_PALETTES,
    NativeThemeBridge,
    SUPPORTED_THEMES,
    apply_window_theme,
    colorref,
)


ROOT = Path(__file__).resolve().parents[1]


class _Handle:
    def ToInt64(self) -> int:
        return 1234


class _Native:
    Handle = _Handle()

    def __init__(self) -> None:
        self.system_updates = 0

    def update_title_bar_theme(self) -> None:
        self.system_updates += 1


class _Window:
    def __init__(self) -> None:
        self.native = _Native()


class ThemeTests(unittest.TestCase):
    @staticmethod
    def _relative_luminance(value: str) -> float:
        channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [
            channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4
            for channel in channels
        ]
        return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2])

    @classmethod
    def _contrast(cls, first: str, second: str) -> float:
        high, low = sorted((cls._relative_luminance(first), cls._relative_luminance(second)), reverse=True)
        return (high + 0.05) / (low + 0.05)

    def test_colorref_uses_win32_bgr_layout_and_rejects_loose_values(self) -> None:
        self.assertEqual(colorref("#112233"), 0x00332211)
        for value in ("112233", "#123", "#gg2233", None):
            with self.assertRaises(ValueError):
                colorref(value)  # type: ignore[arg-type]

    def test_custom_and_system_caption_attributes_are_complete(self) -> None:
        window = _Window()
        calls: list[tuple[int, int, int]] = []

        def setter(hwnd: int, attribute: int, value: int) -> bool:
            calls.append((hwnd, attribute, value))
            return True

        self.assertTrue(apply_window_theme(window, "midnight", set_attribute=setter))
        palette = NATIVE_THEME_PALETTES["midnight"]
        self.assertEqual(calls, [
            (1234, DWMWA_USE_IMMERSIVE_DARK_MODE, 1),
            (1234, DWMWA_BORDER_COLOR, colorref(palette["border"])),
            (1234, DWMWA_CAPTION_COLOR, colorref(palette["caption"])),
            (1234, DWMWA_TEXT_COLOR, colorref(palette["text"])),
        ])

        calls.clear()
        self.assertTrue(apply_window_theme(window, "system", set_attribute=setter))
        self.assertEqual(calls, [
            (1234, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT),
            (1234, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT),
            (1234, DWMWA_TEXT_COLOR, DWMWA_COLOR_DEFAULT),
        ])
        self.assertEqual(window.native.system_updates, 1)

        window.native.update_title_bar_theme = mock.Mock(side_effect=OSError("cosmetic backend failure"))
        calls.clear()
        self.assertTrue(apply_window_theme(window, "system", set_attribute=setter))
        self.assertEqual(len(calls), 3)

    def test_bridge_rejects_unknown_values_and_applies_pending_selection(self) -> None:
        bridge = NativeThemeBridge()
        self.assertFalse(bridge.set_theme("unknown")["ok"])
        pending = bridge.set_theme("forest")
        self.assertTrue(pending["ok"])
        self.assertFalse(pending["nativeApplied"])

        window = _Window()
        with mock.patch.object(worldmedia_theme, "apply_window_theme", return_value=True) as apply:
            bridge._bind_window(window)
            apply.assert_called_once_with(window, "forest")
            result = bridge.set_theme("light")
            self.assertTrue(result["nativeApplied"])
            apply.assert_called_with(window, "light", system_update=None)

    def test_caption_is_repainted_after_each_change(self) -> None:
        window = _Window()
        repainted: list[int] = []
        setter = lambda *_: True  # noqa: E731
        apply_window_theme(window, "dark", set_attribute=setter, refresh=repainted.append)
        apply_window_theme(window, "system", set_attribute=setter, refresh=repainted.append)
        self.assertEqual(repainted, [1234, 1234])
        failing = lambda *_: False  # noqa: E731
        window.native.update_title_bar_theme = mock.Mock(side_effect=OSError("no"))
        apply_window_theme(window, "dark", set_attribute=failing, refresh=repainted.append)
        self.assertEqual(len(repainted), 2, "nothing changed, so nothing to repaint")

    def test_windows_preference_broadcasts_keep_the_app_theme(self) -> None:
        class _Handlers(list):
            def __iadd__(self, handler):
                self.append(handler)
                return self

        class _Events:
            def __init__(self) -> None:
                self.before_show = _Handlers()

        window = _Window()
        window.events = _Events()
        bridge = NativeThemeBridge("dark")
        with mock.patch.object(worldmedia_theme, "apply_window_theme", return_value=True) as apply:
            bridge._bind_window(window)
            apply.assert_called_once_with(window, "dark")
            [on_created] = window.events.before_show
            original = window.native.update_title_bar_theme
            on_created()
            # pywebview's "follow the Windows app theme" repaint now re-applies dark.
            window.native.update_title_bar_theme()
            self.assertEqual(apply.call_count, 3)
            apply.assert_called_with(window, "dark", system_update=original)
            self.assertEqual(window.native.system_updates, 0)
        # Choosing "System" still uses pywebview's original Windows-theme repaint.
        bridge.set_theme("system")
        self.assertEqual(window.native.system_updates, 1)

    def test_saved_theme_is_read_from_the_profile_backup(self) -> None:
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(worldmedia_theme.saved_theme(folder), "system")
            path = Path(folder) / "profile-preferences.json"
            for stored, expected in (('{"theme":"forest"}', "forest"), ('{"theme":"neon"}', "system"), ("not json", "system")):
                path.write_text(json.dumps({"version": 1, "values": {"worldmedia.settings.v1": stored}}), encoding="utf-8")
                self.assertEqual(worldmedia_theme.saved_theme(folder), expected, stored)
            path.write_text("{broken", encoding="utf-8")
            self.assertEqual(worldmedia_theme.saved_theme(folder), "system")
        self.assertEqual(worldmedia_theme.saved_theme(None), "system")
        self.assertEqual(NativeThemeBridge("neon")._theme, "system")

    def test_native_caption_palettes_match_css_chrome_and_text(self) -> None:
        css = (ROOT / "src" / "styles" / "base.css").read_text(encoding="utf-8")
        self.assertEqual(SUPPORTED_THEMES, (
            "system", "dark", "light", "midnight", "forest", "ember", "amethyst",
        ))
        root_block = css.split(":root {", 1)[1].split("}", 1)[0]
        for theme, palette in NATIVE_THEME_PALETTES.items():
            if theme == "dark":
                block = root_block
            else:
                match = re.search(
                    rf":root\[data-theme='{re.escape(theme)}'\]\s*\{{(?P<body>.*?)\}}",
                    css,
                    re.DOTALL,
                )
                self.assertIsNotNone(match, theme)
                block = match.group("body")
            self.assertIn(f"--chrome: {palette['caption']};", block)
            self.assertIn(f"--text: {palette['text']};", block)
            if theme == "light":
                self.assertIn(f"--border-strong: {palette['border']};", block)
            else:
                self.assertIn(f"--border: {palette['border']};", block)

    def test_palette_text_and_accent_pairs_meet_normal_text_contrast(self) -> None:
        css = (ROOT / "src" / "styles" / "base.css").read_text(encoding="utf-8")
        root_block = css.split(":root {", 1)[1].split("}", 1)[0]
        for theme in NATIVE_THEME_PALETTES:
            if theme == "dark":
                block = root_block
            else:
                match = re.search(
                    rf":root\[data-theme='{re.escape(theme)}'\]\s*\{{(?P<body>.*?)\}}",
                    css,
                    re.DOTALL,
                )
                self.assertIsNotNone(match, theme)
                block = match.group("body")
            values = dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6});", block))
            for foreground in ("text", "text-dim", "text-mute"):
                for background in ("bg", "bg-elev-1", "bg-elev-2", "bg-elev-3"):
                    self.assertGreaterEqual(
                        self._contrast(values[background], values[foreground]),
                        4.5,
                        f"{theme} {foreground} on {background}",
                    )
            self.assertGreaterEqual(
                self._contrast(values["accent"], values["accent-contrast"]),
                4.5,
                f"{theme} accent",
            )
            palette = NATIVE_THEME_PALETTES[theme]
            self.assertGreaterEqual(
                self._contrast(palette["caption"], palette["text"]),
                4.5,
                f"{theme} caption",
            )


if __name__ == "__main__":
    unittest.main()
