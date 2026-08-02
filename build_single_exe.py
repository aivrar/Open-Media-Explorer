#!/usr/bin/env python3
"""Build the classic single-file Open Media Explorer executable."""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BUILD_ROOT = ROOT / "build" / "single-exe"
LOCAL_CACHE_DIR = ROOT / "build" / "local-cache"
SPEC_PATH = BUILD_ROOT / "WorldMediaWindows.spec"
WORK_PATH = BUILD_ROOT / "work"
DIST_PATH = ROOT / "dist"
OUTPUT_PATH = DIST_PATH / "WorldMediaWindows.exe"
FRONTEND_PATH = ROOT / "frontend"
ICON_PATH = ROOT / "assets" / "worldmedia.ico"


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def local_build_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    paths = {
        "TEMP": LOCAL_CACHE_DIR / "temp",
        "TMP": LOCAL_CACHE_DIR / "temp",
        "PIP_CACHE_DIR": LOCAL_CACHE_DIR / "pip",
        "PYINSTALLER_CONFIG_DIR": LOCAL_CACHE_DIR / "pyinstaller",
        "PYTHONPYCACHEPREFIX": LOCAL_CACHE_DIR / "pycache",
        "npm_config_cache": LOCAL_CACHE_DIR / "npm",
    }
    for path in set(paths.values()):
        path.mkdir(parents=True, exist_ok=True)
    environment.update({name: str(path) for name, path in paths.items()})
    return environment


def run(command: list[str]) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True, env=local_build_environment())


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest().upper()


def build_frontend() -> None:
    if not (ROOT / "node_modules").is_dir():
        run([npm_command(), "install"])
    run([npm_command(), "run", "build"])


def render_spec() -> str:
    return f"""# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, copy_metadata

# The normal PyInstaller pywebview hook collects its Windows DLL/JS runtime.
# Keep distribution metadata for notices without dragging Android/Cocoa/Qt
# platform modules into this Windows-only executable.
webview_datas = copy_metadata('pywebview')
webview_binaries = []
webview_hiddenimports = []
webview_excludes = [
    'webview.platforms.android',
    'webview.platforms.cef',
    'webview.platforms.cocoa',
    'webview.platforms.gtk',
    'webview.platforms.mshtml',
    'webview.platforms.qt',
]
pythonnet_datas, pythonnet_binaries, pythonnet_hiddenimports = collect_all('pythonnet')
clr_datas, clr_binaries, clr_hiddenimports = collect_all('clr_loader')
# Only ElementTree is used. Bulk collection also imports the optional lxml
# adapter and needlessly bundles the full lxml/BeautifulSoup dependency
# graph. Retain the package's license metadata and hide-import the exact parser.
defusedxml_datas = copy_metadata('defusedxml')

a = Analysis(
    [{str(ROOT / 'worldmedia_native.py')!r}],
    pathex=[{str(ROOT)!r}],
    binaries=webview_binaries + pythonnet_binaries + clr_binaries,
    datas=[
        ({str(FRONTEND_PATH)!r}, 'frontend'),
        ({str(ICON_PATH)!r}, 'assets'),
    ] + webview_datas + pythonnet_datas + clr_datas + defusedxml_datas,
    hiddenimports=webview_hiddenimports + pythonnet_hiddenimports + clr_hiddenimports + [
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
        'clr',
        'defusedxml.ElementTree',
    ],
    hookspath=[],
    hooksconfig={{}},
    runtime_hooks=[],
    excludes=webview_excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='WorldMediaWindows',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon={str(ICON_PATH)!r},
    runtime_tmpdir=None,
)
"""


def write_spec() -> None:
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    SPEC_PATH.write_text(render_spec(), encoding="utf-8")


def build(*, skip_frontend: bool = False) -> Path:
    if not ICON_PATH.is_file():
        raise RuntimeError(f"missing icon: {ICON_PATH}")
    if not skip_frontend:
        build_frontend()
    if not (FRONTEND_PATH / "index.html").is_file():
        raise RuntimeError("frontend build did not produce frontend/index.html")
    write_spec()
    DIST_PATH.mkdir(parents=True, exist_ok=True)
    run([
        sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
        "--workpath", str(WORK_PATH), "--distpath", str(DIST_PATH), str(SPEC_PATH),
    ])
    if not OUTPUT_PATH.is_file() or OUTPUT_PATH.stat().st_size < 1024 * 1024:
        raise RuntimeError(f"single-file build was not created: {OUTPUT_PATH}")
    print(f"Single executable: {OUTPUT_PATH}")
    print(f"EXE SHA-256: {sha256(OUTPUT_PATH)}")
    return OUTPUT_PATH


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-frontend", action="store_true", help="reuse the existing frontend bundle",
    )
    options = parser.parse_args()
    build(skip_frontend=options.skip_frontend)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
