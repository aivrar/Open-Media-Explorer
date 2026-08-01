"""Validated Windows caption theming for the native World Media window."""
from __future__ import annotations

import ctypes
import os
import threading
from typing import Any, Callable


SUPPORTED_THEMES = (
    "system",
    "dark",
    "light",
    "midnight",
    "forest",
    "ember",
    "amethyst",
)

# Keep these caption colors aligned with --chrome, --text, and --border in
# src/styles/base.css. Windows 11 supports the explicit color attributes;
# Windows 10 still receives the matching immersive dark/light preference.
NATIVE_THEME_PALETTES = {
    "dark": {"dark": True, "caption": "#11151b", "text": "#f1f4f7", "border": "#252c37"},
    "light": {"dark": False, "caption": "#dfeaf1", "text": "#15161a", "border": "#b9c6d3"},
    "midnight": {"dark": True, "caption": "#0d1830", "text": "#edf3ff", "border": "#243658"},
    "forest": {"dark": True, "caption": "#10231a", "text": "#eef8f2", "border": "#294137"},
    "ember": {"dark": True, "caption": "#2a1511", "text": "#fff3ee", "border": "#493029"},
    "amethyst": {"dark": True, "caption": "#21112f", "text": "#f7f0ff", "border": "#3e2b54"},
}

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36
DWMWA_COLOR_DEFAULT = 0xFFFFFFFF


def colorref(value: str) -> int:
    """Convert strict #RRGGBB into Win32's 0x00BBGGRR COLORREF form."""
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#":
        raise ValueError("caption colors must use #RRGGBB")
    try:
        red = int(value[1:3], 16)
        green = int(value[3:5], 16)
        blue = int(value[5:7], 16)
    except ValueError as exc:
        raise ValueError("caption colors must use #RRGGBB") from exc
    return red | (green << 8) | (blue << 16)


def _window_handle(window: Any) -> int | None:
    native = getattr(window, "native", None)
    handle = getattr(native, "Handle", None)
    if handle is None:
        return None
    try:
        if hasattr(handle, "ToInt64"):
            return int(handle.ToInt64())
        return int(handle)
    except (TypeError, ValueError, OverflowError):
        return None


def _set_dwm_attribute(hwnd: int, attribute: int, value: int) -> bool:
    if os.name != "nt" or not hwnd:
        return False
    try:
        dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
        setter = dwmapi.DwmSetWindowAttribute
        setter.argtypes = (ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint)
        setter.restype = ctypes.c_long
        data = ctypes.c_uint(value)
        result = setter(
            ctypes.c_void_p(hwnd),
            ctypes.c_uint(attribute),
            ctypes.byref(data),
            ctypes.sizeof(data),
        )
        return result == 0
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def apply_window_theme(
    window: Any,
    theme: str,
    *,
    set_attribute: Callable[[int, int, int], bool] | None = None,
) -> bool:
    """Apply one supported theme to a pywebview WinForms caption."""
    if theme not in SUPPORTED_THEMES:
        return False
    hwnd = _window_handle(window)
    native = getattr(window, "native", None)
    if not hwnd or native is None:
        return False
    setter = set_attribute or _set_dwm_attribute

    if theme == "system":
        results = [
            setter(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT),
            setter(hwnd, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT),
            setter(hwnd, DWMWA_TEXT_COLOR, DWMWA_COLOR_DEFAULT),
        ]
        try:
            native.update_title_bar_theme()
            results.append(True)
        # pywebview's native object crosses the Python/.NET boundary and can
        # surface backend-specific exception types. Caption theming is purely
        # cosmetic, so no backend failure may escape into native app startup.
        except Exception:
            pass
        return any(results)

    palette = NATIVE_THEME_PALETTES[theme]
    results = [
        setter(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, int(palette["dark"])),
        setter(hwnd, DWMWA_BORDER_COLOR, colorref(palette["border"])),
        setter(hwnd, DWMWA_CAPTION_COLOR, colorref(palette["caption"])),
        setter(hwnd, DWMWA_TEXT_COLOR, colorref(palette["text"])),
    ]
    return any(results)


class NativeThemeBridge:
    """One-method pywebview API with a strict theme allowlist."""

    def __init__(self) -> None:
        self._window: Any = None
        self._theme = "system"
        self._lock = threading.RLock()

    def _bind_window(self, window: Any) -> None:
        with self._lock:
            self._window = window
            apply_window_theme(window, self._theme)

    def set_theme(self, theme: Any) -> dict[str, Any]:
        if not isinstance(theme, str) or theme not in SUPPORTED_THEMES:
            return {"ok": False, "theme": self._theme, "error": "unsupported theme"}
        with self._lock:
            self._theme = theme
            applied = apply_window_theme(self._window, theme) if self._window is not None else False
        return {"ok": True, "theme": theme, "nativeApplied": applied}
