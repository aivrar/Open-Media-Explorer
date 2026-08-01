# Developer and release guide

## Repository structure

The UI is under `src/` and is bundled by Vite into `frontend/`. The Windows
runtime is the Python files at repository root. The most important boundaries
are listed in [docs/FILE_TREE.md](../FILE_TREE.md).

| Area | Primary files |
|---|---|
| Source registry/adapters | `src/lib/sources.js`, `src/adapters/*.js` |
| Library collection | `src/modes/library/`, `src/lib/search.js`, `src/lib/catalog-scheduler.js` |
| Grid/Tuner/Discovery | `src/modes/grid.js`, `src/modes/tuner.js`, `src/modes/discovery.js` |
| Player and failover | `src/lib/player.js`, `src/lib/media-failover.js`, `src/lib/hls-recovery.js`, `src/lib/dash-player.js` |
| Artwork | `src/lib/artwork.js`, `src/modes/library/thumbnails.js` |
| EQ | `src/lib/audio-engine.js`, `src/lib/eq-store.js`, `src/lib/eq-overlay.js` |
| Capture UI/client | `src/lib/capture-ui.js`, `src/lib/capture-client.js`, `src/lib/download-client.js`, `src/lib/recording-client.js` |
| Native server/security | `worldmedia_server.py`, `worldmedia_security.py`, `worldmedia_catalog.py`, `worldmedia_media.py` |
| Jobs/downloads/recording | `worldmedia_jobs.py`, `worldmedia_downloads.py`, `worldmedia_recording.py`, `worldmedia_ffmpeg.py` |
| Runtime/launcher | `worldmedia_native.py`, `worldmedia_runtime.py`, `worldmedia_theme.py` |

## Local setup

Requirements are Node.js for the frontend/test toolchain and Python for the
build/test harness. End users of a packaged EXE do not need either runtime.

```powershell
npm install
```

Run the frontend test suite:

```powershell
npm test
```

Run Python tests:

```powershell
python -m unittest discover -s tests_python -v
```

Build the frontend:

```powershell
npm run build
```

The current repository baseline is 286 JavaScript tests and 148 Python tests;
the exact count should be reported by the command rather than assumed after
future changes.

## Development server

`npm run dev` starts Vite for frontend work. It is not the packaged desktop
runtime and does not exercise the native server, WebView2 profile, relays,
FFmpeg, or portable data layout. Use the Python launcher/server for integrated
testing, with a non-conflicting local port when required.

## Packaging

Install build dependencies from the pinned requirements file, then build the
classic one-file EXE or the folder/ZIP portable release:

```powershell
python -m pip install --cache-dir .\build\local-cache\pip -r requirements-build.txt
python .\build_single_exe.py --skip-frontend
python .\build_windows.py --skip-frontend
```

Outputs are normally:

```text
dist\WorldMediaWindows.exe
dist\WorldMediaWindows\WorldMediaWindows.exe
dist\WorldMediaWindows-0.1.2-portable.zip
```

`--skip-frontend` assumes `frontend/` was already produced by `npm run build`.
The full release/smoke flow is in [docs/BUILD_WINDOWS.md](../BUILD_WINDOWS.md)
and [docs/RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md).

## Safe portable test workflow

Use a separate test root such as:

```text
dist\PortableTest\WorldMediaWindows.exe
dist\PortableTest\WorldMediaWindows-data\
```

Before replacing the EXE:

1. Ask the app to shut down and confirm the process has exited.
2. Copy the current EXE to a backup name or record its hash.
3. Copy the new EXE into the test root without touching the data directory.
4. Launch and verify Settings runtime paths, Favorites count, a Library source,
   Grid artwork, playback, and Shutdown.

Do not use `git clean`, recursive deletion, or a profile reset against a user
data directory without an explicit backup and approval.

## Tests worth running after source/runtime changes

- `npm test` for adapter contracts, cursor progression, scheduler fairness,
  player/failover, EQ, thumbnails, accessibility, and capture state.
- Python unittest discovery for frozen backend schemas, fixture server,
  security, job transitions, runtime paths, download/recording seams, and
  packaging contracts.
- The optional real FFmpeg/download smoke test only when deliberately enabled;
  it downloads a large external toolchain and is not part of the default suite.

## Adding or changing a source

1. Add the source definition to `src/lib/sources.js` (ID, display name, types,
   color, homepage, description, rights note, capabilities).
2. Add a lazy adapter loader entry.
3. Implement the adapter contract (`search`, `browsePage`, `random`, and any
   `resolveStream`, `resolveArtwork`, or `refreshSnapshot` behavior needed).
4. Declare a `catalogPolicy` when the provider needs a concurrency or pacing
   limit.
5. Normalize IDs, URLs, content ratings, delivery type, licenses, download
   names, and capture headers; never return private origins or sensitive query
   tokens.
6. Add deterministic fixtures and retry/cursor tests.
7. Update `docs/PROVIDERS.md` and this wiki's source table.
8. Run both test suites and perform an opt-in live probe only when necessary.
