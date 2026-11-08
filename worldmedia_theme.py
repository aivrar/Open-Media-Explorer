"""Validated Windows caption theming for the native World Media window."""
from __future__ import annotations

import ctypes
import json
import os
import threading
from pathlib import Path
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


WM_NCACTIVATE = 0x0086
RDW_INVALIDATE = 0x0001
RDW_FRAME = 0x0400


def _refresh_caption(hwnd: int) -> None:
    """Make Windows 10 repaint the title bar now.

    Windows 10 stores a new dark/light caption preference but keeps showing the
    old caption until the window is next activated or deactivated, which left
    the bar white until the user clicked another app. Re-sending the current
    activation state repaints it in place without changing focus.
    """

    if os.name != "nt" or not hwnd:
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        user32.PostMessageW.argtypes = (ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t)
        user32.RedrawWindow.argtypes = (ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint)
        active = user32.GetForegroundWindow() == hwnd
        # Posted (not sent) so a call from the JS bridge thread can never block
        # on the UI thread; the two messages are handled in order.
        user32.PostMessageW(ctypes.c_void_p(hwnd), WM_NCACTIVATE, int(not active), 0)
        user32.PostMessageW(ctypes.c_void_p(hwnd), WM_NCACTIVATE, int(active), 0)
        user32.RedrawWindow(ctypes.c_void_p(hwnd), None, None, RDW_FRAME | RDW_INVALIDATE)
    except (AttributeError, OSError, TypeError, ValueError):
        pass


def apply_window_theme(
    window: Any,
    theme: str,
    *,
    set_attribute: Callable[[int, int, int], bool] | None = None,
    refresh: Callable[[int], None] | None = None,
    system_update: Callable[[], Any] | None = None,
) -> bool:
    """Apply one supported theme to a pywebview WinForms caption."""
    if theme not in SUPPORTED_THEMES:
        return False
    hwnd = _window_handle(window)
    native = getattr(window, "native", None)
    if not hwnd or native is None:
        return False
    setter = set_attribute or _set_dwm_attribute
    if refresh is None and set_attribute is None:
        refresh = _refresh_caption

    if theme == "system":
        results = [
            setter(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT),
            setter(hwnd, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT),
            setter(hwnd, DWMWA_TEXT_COLOR, DWMWA_COLOR_DEFAULT),
        ]
        try:
            (system_update or native.update_title_bar_theme)()
            results.append(True)
        # pywebview's native object crosses the Python/.NET boundary and can
        # surface backend-specific exception types. Caption theming is purely
        # cosmetic, so no backend failure may escape into native app startup.
        except Exception:
            pass
    else:
        palette = NATIVE_THEME_PALETTES[theme]
        results = [
            setter(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, int(palette["dark"])),
            setter(hwnd, DWMWA_BORDER_COLOR, colorref(palette["border"])),
            setter(hwnd, DWMWA_CAPTION_COLOR, colorref(palette["caption"])),
            setter(hwnd, DWMWA_TEXT_COLOR, colorref(palette["text"])),
        ]
    if refresh is not None and any(results):
        refresh(hwnd)
    return any(results)


def saved_theme(state_dir: str | os.PathLike[str] | None) -> str:
    """The theme saved in the portable profile backup, or "system".

    Lets the native caption start in the right colour instead of showing the
    Windows default until the page loads and reports its theme.
    """

    if not state_dir:
        return "system"
    try:
        path = Path(state_dir) / "profile-preferences.json"
        if path.stat().st_size > 4 * 1024 * 1024:
            return "system"
        values = json.loads(path.read_text(encoding="utf-8")).get("values") or {}
        theme = json.loads(values.get("worldmedia.settings.v1") or "{}").get("theme")
    except (OSError, ValueError, TypeError, AttributeError):
        return "system"
    return theme if theme in SUPPORTED_THEMES else "system"


class NativeThemeBridge:
    """One-method pywebview API with a strict theme allowlist."""

    def __init__(self, initial_theme: str = "system") -> None:
        self._window: Any = None
        self._theme = initial_theme if initial_theme in SUPPORTED_THEMES else "system"
        self._system_update: Callable[[], Any] | None = None
        self._lock = threading.RLock()

    def _apply(self) -> bool:
        return apply_window_theme(self._window, self._theme, system_update=self._system_update)

    def _bind_window(self, window: Any) -> None:
        with self._lock:
            self._window = window
            apply_window_theme(window, self._theme)
        events = getattr(window, "events", None)
        if getattr(events, "before_show", None) is not None:
            events.before_show += self._on_native_created

    def _on_native_created(self) -> None:
        """Runs on the UI thread once the native form exists, before it is shown.

        pywebview repaints the caption to the Windows app theme when the form is
        created and on every Windows "user preference changed" broadcast, which
        turned a dark app's title bar white again at random. Route those
        repaints through the app's own theme instead.
        """

        native = getattr(self._window, "native", None)
        if native is None:
            return
        with self._lock:
            original = getattr(native, "update_title_bar_theme", None)
            if callable(original) and self._system_update is None:
                try:
                    native.update_title_bar_theme = self._on_system_repaint
                    self._system_update = original
                except (AttributeError, TypeError):
                    pass
            self._apply()

    def _on_system_repaint(self) -> None:
        try:
            with self._lock:
                self._apply()
        # Cosmetic only; never let a caption failure escape into a .NET event.
        except Exception:
            pass

    def set_theme(self, theme: Any) -> dict[str, Any]:
        if not isinstance(theme, str) or theme not in SUPPORTED_THEMES:
            return {"ok": False, "theme": self._theme, "error": "unsupported theme"}
        with self._lock:
            self._theme = theme
            applied = self._apply() if self._window is not None else False
        return {"ok": True, "theme": theme, "nativeApplied": applied}
