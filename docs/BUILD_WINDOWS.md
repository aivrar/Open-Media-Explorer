# Build Windows Releases

The classic single-file artifact and signed-runtime portable fallback are:

```text
dist\WorldMediaWindows.exe
dist\WorldMediaWindows\WorldMediaWindows.exe
dist\WorldMediaWindows-0.1.2-portable.zip
```

`dist\WorldMediaWindows.exe` is the owner-preferred one-file PyInstaller build.
It is unsigned and may trigger generic antivirus heuristics; locally allowing
the exact build directory, code-signing the artifact, or obtaining a vendor
false-positive correction may be necessary. `build_single_exe.py` disables UPX
and pins the complete PyInstaller toolchain to make this output reproducible.

The portable folder bundles:

- Python runtime
- World Media local HTTP/proxy server
- Built Vite frontend
- pywebview desktop shell
- WebView/pythonnet bridge files
- World Media icon

The launcher is the unmodified, Authenticode-signed `pythonw.exe` from Python's
official 3.13.14 x64 embedded distribution, renamed to
`WorldMediaWindows.exe`. A restricted `python313._pth` isolates it from system
Python installations. This layout avoids generic antivirus detections observed
against freshly generated unsigned PyInstaller launchers. The build downloads
the official archive only from `python.org` and verifies its pinned SHA-256
before extraction.

## Developer Requirements

- Windows 10 22H2 or Windows 11, 64-bit. The managed BtbN FFmpeg provider does
  not guarantee older Windows versions.
- Python 3.13+
- Node.js 20+
- npm 10+
- Build dependencies from `requirements-build.txt`

Desktop dependencies are release-pinned to pywebview 6.2.1 and pythonnet 3.1.0.
The build script also pins their complete runtime dependency set. Install the
top-level dependencies with:

```powershell
python -m pip install --cache-dir .\build\local-cache\pip -r requirements-build.txt
```

## Build

```powershell
npm ci
npm test
npm run build
python .\build_windows.py --skip-frontend
python .\build_single_exe.py --skip-frontend
```

Or let the build script install/build the frontend first:

```powershell
python .\build_windows.py
python .\build_single_exe.py
```

## Smoke Test

Headless server mode:

```powershell
$env:WORLDMEDIA_NO_BROWSER = "1"
$env:WORLDMEDIA_WINDOWS_PORT = "19824"
$p = Start-Process -FilePath ".\dist\WorldMediaWindows.exe" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:19824/api/health"
$session = Invoke-RestMethod -Uri "http://127.0.0.1:19824/api/v1/session"
$headers = @{
    Origin = "http://127.0.0.1:19824"
    "X-WorldMedia-Token" = $session.data.token
}
Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:19824/api/shutdown" `
    -Headers $headers -ContentType "application/json" -Body "{}"
Wait-Process -Id $p.Id -Timeout 5
Remove-Item Env:WORLDMEDIA_NO_BROWSER
Remove-Item Env:WORLDMEDIA_WINDOWS_PORT
```

Normal desktop launch:

```powershell
.\dist\WorldMediaWindows.exe
```

Expected behavior:

- Native desktop window opens.
- Local server responds on `127.0.0.1`.
- Runtime logs appear under `dist\WorldMediaWindows-data\logs\` beside the EXE.
- Single-EXE startup extraction uses the Windows temporary directory and its
  `_MEI...` directory is removed on normal shutdown. This makes the EXE
  relocatable across computers and drive letters.
- npm, pip, Python test temp/bytecode, and PyInstaller caches for this repository
  stay under `build\local-cache\`.

## Catalog, Cache, And Network Boundaries

The app registers all eleven adapters lazily and gives every source an
independent global scheduler slot. Adapter-declared limits add stricter
per-provider concurrency and request spacing. Library collection keeps
advancing each available cursor while the mode is active; a slow or
rate-limited source does not stop healthy sources. Failures honor `Retry-After`
or exponential cooldown and retain the same cursor unless the provider returns
an authoritative end marker. The DOM remains capped at 300 mounted cards, but
the complete collected catalog remains resident for the app session without an
application item ceiling.

The steady-state performance boundaries are independent: catalog metadata has
eleven fair source lanes and a 60-second final watchdog; artwork uses twelve
priority lanes with a 25-second watchdog; the localhost server accepts a
128-request backlog and sixteen simultaneous artwork relays. Library filter
results are incrementally extended for append-only pages, so a 40,000-item
session is not rescanned after every 30-item response. IPTV filter views are
memoized. Catalog/artwork caches keep validated atomic files and bounded disk
budgets, but prune with hysteresis and never force a physical disk flush per
thumbnail or feed response. Expiring artwork and HLS/DASH registrations use
heaps rather than full-registry scans.

Fixed metadata hosts use the DNS-pinned HTTPS allowlist in
`worldmedia_server.py`. Dynamic publisher feeds, PeerTube origins, and Owncast
instances use semantic handlers in `worldmedia_catalog.py`; they never widen the
generic proxy. Artwork and media enter separate opaque registries. The catalog
cache is versioned and bounded to 64 MiB, and Clear cache never touches user
favorites, settings, EQ curves, downloads, or recordings. See
`docs/PROVIDERS.md` for every endpoint and refresh policy.

Deterministic catalog tests use local fixtures. Public-provider probes are
opt-in and their volatile failures must be recorded separately from release
defects:

```powershell
$env:WORLDMEDIA_STATE_ROOT = "$PWD\build\release-live-gpodder"
$env:WORLDMEDIA_GPODDER_LIVE = "1"
python .\tests_python\gpodder_live_smoke.py

$env:WORLDMEDIA_STATE_ROOT = "$PWD\build\release-live-peertube"
$env:WORLDMEDIA_PEERTUBE_LIVE = "1"
python .\tests_python\peertube_live_smoke.py

$env:WORLDMEDIA_STATE_ROOT = "$PWD\build\release-live-owncast"
$env:WORLDMEDIA_OWNCAST_LIVE = "1"
python .\tests_python\owncast_live_smoke.py

Remove-Item Env:WORLDMEDIA_STATE_ROOT
Remove-Item Env:WORLDMEDIA_GPODDER_LIVE
Remove-Item Env:WORLDMEDIA_PEERTUBE_LIVE
Remove-Item Env:WORLDMEDIA_OWNCAST_LIVE
```

The disposable state roots are mandatory. Never run live probes against a
user's normal WebView2 state directory.

## Bundled DASH Playback

The Vite production bundle includes dash.js 5.2.0 for non-DRM MPEG-DASH
playback in WebView2. dash.js is BSD-3-Clause licensed; its upstream license is
linked from About and the README. MPDs and segments still traverse World
Media's opaque, DNS-pinned relay. The backend rewrites constrained DASH
templates and rejects DRM, external XLink expansion, XML entities, content
steering, and reporting endpoints before dash.js sees the manifest.

## Optional Managed FFmpeg

FFmpeg is deliberately not embedded in the portable folder. At runtime the
app probes, in order, an explicit `WORLDMEDIA_FFMPEG_PATH` override, a managed
portable copy, the system `PATH`, and a managed LocalAppData fallback. Both
`ffmpeg.exe` and `ffprobe.exe` must report every protocol, demuxer, decoder,
encoder, and muxer required by the fixed recording profiles.

The Settings dialog can install the pinned FFmpeg n8.1 win64 GPL 8.1 build from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). Installation requires
explicit confirmation and no administrator rights. The downloader verifies the
GitHub repository, exact asset name, size, content type, and SHA-256 digest;
rejects unsafe ZIP entries; and stages and probes the binaries before atomically
changing `current.json`. Managed copies retain upstream license files,
`manifest.json`, and `SOURCE.txt`. Repair and removal operate only on these
managed roots and never remove a system `PATH` toolchain.

The provider documents Windows 10 22H2 as its minimum supported version. The
managed asset is intentionally not included in the release ZIP or Git tree. To
replace it, use Repair after the pinned provider metadata is updated
and tested. To remove it, use Remove managed copy in Settings; the operation is
confined to the selected portable or LocalAppData managed root.

The three profiles are Compact (96 kbps audio, up to 480p video), Balanced
(160 kbps, up to 720p), and High (256 kbps, up to 1080p). Recording consumes the
live relay independently from the player's pause/mute/volume/EQ state. Stop
requests graceful FFmpeg finalization; only a validated MP3 or H.264/AAC MP4
receives the completed filename. Interrupted fragmented MP4 is preserved under
an explicitly recoverable filename only when validation succeeds.

The scheduled/manual `FFmpeg provider integration` workflow performs the real
160+ MiB download/install/probe smoke on a clean Windows runner. Normal unit tests
remain offline and fixture-based. See [FFmpeg legal information](https://ffmpeg.org/legal.html).

## Finite Download Verification

Original finite files are streamed without FFmpeg into the portable
`downloads` directory beside the EXE. The frontend first exchanges the upstream
URL for an opaque media registration, and `POST /api/v1/jobs/download` accepts
only that registration ID. The backend selects a trusted extension, confines
all paths to the non-reparse portable root, writes an exclusive `.part` file,
uses validator-safe Range resume, and publishes atomically after completion.
Cancelled and failed work never receives a final filename.

There is no automatic alternate media-download root: the requested portable
`downloads` directory is shown as unavailable when the EXE folder is read-only.
Managed FFmpeg is separate and may be installed into the explicitly selected
per-user LocalAppData fallback. Runtime `downloads/` and `tools/` are ignored by
Git and are never embedded in a clean release build.

Downloading or recording does not grant content rights. Test only material for
which the source license and local law allow capture; DRM is not bypassed.

Normal tests use the local fixture server. The opt-in public-source smoke uses
small-to-moderate Internet Archive, NASA, Wikimedia, and LibriVox originals in
an isolated temporary portable root:

```powershell
$env:WORLDMEDIA_DOWNLOAD_INTEGRATION = "1"
python .\tests_python\download_real_smoke.py
Remove-Item Env:WORLDMEDIA_DOWNLOAD_INTEGRATION
```

To run the complete real download/recording gate against the classic one-file
artifact itself:

```powershell
$env:WORLDMEDIA_SINGLE_EXE_INTEGRATION = "1"
python .\tests_python\single_exe_real_smoke.py
Remove-Item Env:WORLDMEDIA_SINGLE_EXE_INTEGRATION
```

## Clean Release Gate

```powershell
npm ci
npm audit --audit-level=high
npm test
python -m unittest discover -s tests_python -p "test_*.py"
npm run build
python .\build_windows.py --skip-frontend
python .\build_single_exe.py --skip-frontend
```

Run the headless smoke above against `python worldmedia_native.py`,
`dist\WorldMediaWindows.exe`, and `dist\WorldMediaWindows\WorldMediaWindows.exe`.
Confirm each packaged server also serves
`/THIRD_PARTY_NOTICES.txt`, then launch the desktop EXE from a writable test
folder. Follow every gate in `docs/RELEASE_CHECKLIST.md`.
