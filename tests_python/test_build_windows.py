from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_windows
import build_single_exe


class PortableBuildTests(unittest.TestCase):
    def test_build_caches_stay_in_workspace(self) -> None:
        for module in (build_windows, build_single_exe):
            environment = module.local_build_environment({})
            for name in (
                "TEMP",
                "TMP",
                "PIP_CACHE_DIR",
                "PYINSTALLER_CONFIG_DIR",
                "PYTHONPYCACHEPREFIX",
                "npm_config_cache",
            ):
                Path(environment[name]).resolve().relative_to(build_windows.ROOT)

    def test_onefile_extraction_is_relocatable(self) -> None:
        spec = build_single_exe.render_spec()
        self.assertIn("runtime_tmpdir=None", spec)
        self.assertNotIn(str(build_single_exe.ROOT), spec.split("runtime_tmpdir=", 1)[1])

    def test_embedded_runtime_source_is_https_and_checksum_pinned(self) -> None:
        self.assertEqual(build_windows.PYTHON_VERSION, "3.13.14")
        self.assertTrue(build_windows.PYTHON_URL.startswith("https://www.python.org/"))
        self.assertRegex(build_windows.PYTHON_SHA256, r"^[A-F0-9]{64}$")
        self.assertIn("python-3.13.14-embed-amd64.zip", build_windows.PYTHON_URL)

    def test_every_runtime_dependency_is_exactly_pinned(self) -> None:
        requirements = [
            *build_windows.RUNTIME_WHEELS,
            *build_windows.RUNTIME_SOURCE_PACKAGES,
        ]
        self.assertTrue(requirements)
        self.assertTrue(all(requirement.count("==") == 1 for requirement in requirements))
        self.assertEqual(build_windows.RUNTIME_SOURCE_PACKAGES, ("proxy_tools==0.1.0",))
        self.assertIn("defusedxml==0.7.1", build_windows.RUNTIME_WHEELS)

    def test_pruning_removes_only_unused_platform_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site_packages = Path(directory)
            library = site_packages / "webview" / "lib"
            x64 = library / "runtimes" / "win-x64" / "native" / "WebView2Loader.dll"
            unwanted = (
                library / "pywebview-android.jar",
                library / "WebBrowserInterop.x86.dll",
                library / "runtimes" / "win-arm64" / "native" / "WebView2Loader.dll",
                library / "runtimes" / "win-x86" / "native" / "WebView2Loader.dll",
            )
            for path in (x64, *unwanted):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"test")

            build_windows.prune_unused_payloads(site_packages)

            self.assertTrue(x64.is_file())
            self.assertTrue(all(not path.exists() for path in unwanted))

    def test_runtime_configuration_is_isolated_and_records_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            assets = root / "assets"
            (output / "Lib" / "site-packages").mkdir(parents=True)
            (assets / "embedded").mkdir(parents=True)
            (assets / "embedded" / "sitecustomize.py").write_text("# launcher\n", encoding="utf-8")

            with mock.patch.object(build_windows, "OUTPUT_DIR", output), mock.patch.object(
                build_windows, "ASSET_DIR", assets
            ):
                build_windows.write_runtime_configuration()

            self.assertEqual(
                (output / "python313._pth").read_text(encoding="utf-8"),
                "python313.zip\n.\nLib\\site-packages\nimport site\n",
            )
            self.assertTrue((output / "Lib" / "site-packages" / "sitecustomize.py").is_file())
            manifest = json.loads((output / "BUILD_MANIFEST.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["python_archive_sha256"], build_windows.PYTHON_SHA256)
            self.assertEqual(
                manifest["runtime_requirements"],
                [*build_windows.RUNTIME_WHEELS, *build_windows.RUNTIME_SOURCE_PACKAGES],
            )
            self.assertIn("defusedxml==0.7.1", manifest["runtime_requirements"])


if __name__ == "__main__":
    unittest.main()
