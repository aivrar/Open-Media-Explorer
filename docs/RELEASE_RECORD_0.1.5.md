# v0.1.5 release verification - 2026-11-08

Release scope: portable ZIP startup fix for
[issue #3](https://github.com/aivrar/Open-Media-Explorer/issues/3). The ZIP
again ships all three pywebview WebView2 runtime folders (win-arm64, win-x64,
win-x86), which pywebview 6.2.1 requires at import time; the app clears the
downloaded-file mark (`Zone.Identifier`) from its own bundled .NET DLLs before
loading the window component; and the embedded launcher exits after a startup
failure instead of falling through to a hidden interactive prompt. The single
EXE has no functional changes beyond the version number. See
[release notes](RELEASE_NOTES_0.1.5.md).

## Root cause

- Since v0.1.2 the portable build pruned `webview/lib/runtimes/win-arm64` and
  `win-x86`. pywebview's EdgeChromium backend adds all three to `Path` at import
  and raises "Cannot find win-arm64" when one is missing, so the ZIP could not
  open a window on any PC.
- Explorer copies a downloaded ZIP's mark onto each extracted file; .NET
  Framework then refuses to load `Python.Runtime.dll` ("Failed to resolve
  Python.Runtime.Loader.Initialize"), as reported in issue #3.
- Release checks launched the packages headless only, which never loads the
  window component. The checklist now has a windowed ZIP launch gate.

## Evidence

- `npm test`: 313 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 187 passing tests
  (new: runtime folders kept, launcher exits, assembly unblocking).
- `python -m ruff check --select F,E9`: clean.
- `npm run build`: succeeds with the existing dash.js warnings.
- Portable ZIP extracted twice into new folders, one with every file marked as
  downloaded (`ZoneId=3`): both opened a visible window (4.5 s and 5.0 s). The
  previous v0.1.4 ZIP failed both ways under the same procedure.
- A deliberately broken copy (runtime folder removed) exited with code 1, logged
  the reason to `logs\native.log`, and left no process running.
- ZIP integrity: 450 entries; all three runtime folders present; bundled frontend
  byte-identical to `frontend/`; no profiles, logs, or repository metadata.
- Single EXE marked as downloaded opened a visible window (4.0 s) and served the
  0.1.5 frontend bundle and notices.
- `tests_python/playlist_release_browser_smoke.py` against the packaged EXE:
  every check passed (radio, M3U import, HLS and DASH playback, Favorites, all
  modes, save-failure warning, Shutdown, restart persistence).

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,944,192 | `906DA01FCEDA1978B33E59BB30781EB255F01A18AD443B7DF888465F49F98B79` |
| `WorldMediaWindows-0.1.5-portable.zip` | 14,774,613 | `B29EE1630EC38A164E5187638AA4C19409808792767A4F087B6B7C09EF5FFF2B` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Windowed launches were verified on Windows 10 x64. The arm64 and x86 runtime
folders are shipped because pywebview requires them to exist; the embedded
Python runtime itself is x64 only. The v0.1.4 boundaries still apply.
