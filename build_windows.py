#!/usr/bin/env python3
"""Build the antivirus-friendly portable Windows distribution."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
ASSET_DIR = ROOT / "assets"
FRONTEND_DIR = ROOT / "frontend"
DIST_DIR = ROOT / "dist"
BUILD_DIR = ROOT / "build"
LOCAL_CACHE_DIR = BUILD_DIR / "local-cache"
OUTPUT_DIR = DIST_DIR / "WorldMediaWindows"
ARCHIVE_PATH = DIST_DIR / "WorldMediaWindows-0.1.2-portable.zip"
PYTHON_VERSION = "3.13.14"
PYTHON_ARCHIVE = f"python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{PYTHON_ARCHIVE}"
PYTHON_SHA256 = "90B4E5B9898B72D744650524BFF92377C367F44BD5FBD09E3148656C080AD907"
RUNTIME_WHEELS = (
    "bottle==0.13.4",
    "cffi==2.1.0",
    "clr_loader==0.3.1",
    "defusedxml==0.7.1",
    "packaging==26.2",
    "pycparser==3.0",
    "pythonnet==3.1.0",
    "pywebview==6.2.1",
    "typing_extensions==4.16.0",
)
RUNTIME_SOURCE_PACKAGES = ("proxy_tools==0.1.0",)


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


def run(cmd: list[str]) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True, env=local_build_environment())


def build_frontend() -> None:
    if not (ROOT / "node_modules").is_dir():
        run([npm_command(), "install"])
    run([npm_command(), "run", "build"])
    if not (FRONTEND_DIR / "index.html").is_file():
        raise RuntimeError("frontend build did not produce frontend/index.html")


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest().upper()


def acquire_embedded_python() -> Path:
    cache = BUILD_DIR / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / PYTHON_ARCHIVE
    if archive.is_file() and sha256(archive) == PYTHON_SHA256:
        return archive
    archive.unlink(missing_ok=True)
    partial = archive.with_suffix(".zip.part")
    partial.unlink(missing_ok=True)
    print(f"+ download {PYTHON_URL}", flush=True)
    urllib.request.urlretrieve(PYTHON_URL, partial)
    actual = sha256(partial)
    if actual != PYTHON_SHA256:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"embedded Python checksum mismatch: {actual}")
    partial.replace(archive)
    return archive


def install_runtime_dependencies(target: Path) -> None:
    run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-compile",
        "--only-binary=:all:",
        "--no-deps",
        "--upgrade",
        "--target",
        str(target),
        *RUNTIME_WHEELS,
    ])
    # proxy_tools 0.1.0 has no wheel on PyPI. It is installed separately with
    # dependencies disabled; every dependency it needs is pinned above.
    run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-compile",
        "--no-deps",
        "--upgrade",
        "--target",
        str(target),
        *RUNTIME_SOURCE_PACKAGES,
    ])


def prune_unused_payloads(site_packages: Path) -> None:
    webview = site_packages / "webview"
    for path in (
        webview / "lib" / "pywebview-android.jar",
        webview / "lib" / "WebBrowserInterop.x86.dll",
        webview / "lib" / "runtimes" / "win-arm64",
        webview / "lib" / "runtimes" / "win-x86",
    ):
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def write_runtime_configuration() -> None:
    (OUTPUT_DIR / "python313._pth").write_text(
        "python313.zip\n.\nLib\\site-packages\nimport site\n",
        encoding="utf-8",
    )
    site_packages = OUTPUT_DIR / "Lib" / "site-packages"
    shutil.copy2(ASSET_DIR / "embedded" / "sitecustomize.py", site_packages / "sitecustomize.py")
    manifest = {
        "application": "World Media",
        "version": "0.1.2",
        "python": PYTHON_VERSION,
        "python_archive": PYTHON_ARCHIVE,
        "python_archive_sha256": PYTHON_SHA256,
        "runtime_requirements": [*RUNTIME_WHEELS, *RUNTIME_SOURCE_PACKAGES],
    }
    (OUTPUT_DIR / "BUILD_MANIFEST.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def assemble_portable_folder() -> None:
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    archive = acquire_embedded_python()
    OUTPUT_DIR.mkdir(parents=True)
    with zipfile.ZipFile(archive) as source:
        source.extractall(OUTPUT_DIR)

    launcher = OUTPUT_DIR / "pythonw.exe"
    if not launcher.is_file():
        raise RuntimeError("embedded Python archive did not contain pythonw.exe")
    launcher.replace(OUTPUT_DIR / "WorldMediaWindows.exe")
    (OUTPUT_DIR / "python.exe").unlink(missing_ok=True)

    site_packages = OUTPUT_DIR / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    install_runtime_dependencies(site_packages)
    prune_unused_payloads(site_packages)

    for module in sorted(ROOT.glob("worldmedia_*.py")):
        shutil.copy2(module, OUTPUT_DIR / module.name)
    shutil.copytree(FRONTEND_DIR, OUTPUT_DIR / "frontend")
    shutil.copytree(ASSET_DIR, OUTPUT_DIR / "assets", ignore=shutil.ignore_patterns("embedded"))
    write_runtime_configuration()

    ARCHIVE_PATH.unlink(missing_ok=True)
    shutil.make_archive(
        str(ARCHIVE_PATH.with_suffix("")), "zip", root_dir=DIST_DIR, base_dir=OUTPUT_DIR.name
    )
    print(f"Portable folder: {OUTPUT_DIR}", flush=True)
    print(f"Release archive: {ARCHIVE_PATH}", flush=True)
    print(f"Archive SHA-256: {sha256(ARCHIVE_PATH)}", flush=True)


def build(skip_frontend: bool = False) -> None:
    if not (ASSET_DIR / "worldmedia.ico").is_file():
        raise RuntimeError("missing World Media icon")
    if not (ASSET_DIR / "embedded" / "sitecustomize.py").is_file():
        raise RuntimeError("missing embedded runtime launcher")
    if not skip_frontend:
        build_frontend()
    assemble_portable_folder()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-frontend", action="store_true", help="reuse existing frontend/ bundle")
    args = parser.parse_args()
    build(skip_frontend=args.skip_frontend)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
