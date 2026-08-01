# File Tree

```text
WorldMediaWindows/
|-- .github/
|   |-- ISSUE_TEMPLATE/
|   |-- workflows/
|   |   |-- ci.yml
|   |   `-- ffmpeg-integration.yml
|   `-- pull_request_template.md
|-- assets/
|   |-- embedded/
|   |   `-- sitecustomize.py
|   |-- worldmedia.ico
|   `-- worldmedia-icon.png
|-- docs/
|   |-- screenshots/
|   |-- wiki/
|   |-- BUILD_WINDOWS.md
|   |-- FILE_TREE.md
|   |-- WIKI.md
|   |-- PROVIDERS.md
|   |-- FIVE_NEW_SOURCES_PHASES.md
|   |-- FIVE_NEW_SOURCES_RESEARCH.md
|   |-- FIVE_NEW_SOURCES_EXECUTION_LOG.md
|   |-- PLAYER_CAPTURE_EQ_PHASES.md
|   |-- PLAYER_CAPTURE_EQ_RESEARCH.md
|   |-- PLAYER_CAPTURE_EQ_EXECUTION_LOG.md
|   |-- FINAL_COMPLETION_AUDIT.md
|   |-- RELEASE_NOTES_0.1.2.md
|   |-- RELEASE_CHECKLIST.md
|   `-- REPOSITORY_SETUP.md
|-- frontend/
|   |-- assets/
|   `-- index.html
|-- public/
|   `-- THIRD_PARTY_NOTICES.txt
|-- screenshots/
|   |-- updated screenshots/
|   |-- 1.PNG
|   |-- 2.PNG
|   |-- 3.PNG
|   |-- 4.PNG
|   `-- 5.PNG
|-- src/
|   |-- adapters/
|   |-- lib/
|   |-- modes/
|   |-- styles/
|   |-- vendor/
|   `-- index.html
|-- tests/
|   |-- fixtures/
|   |-- helpers/
|   |-- contracts.test.js
|   |-- accessibility.test.js
|   |-- discovery.test.js
|   |-- harness.test.js
|   `-- thumbnails.test.js
|-- tests_python/
|   |-- fixtures/
|   |-- fakes.py
|   |-- fixture_server.py
|   |-- test_contract_schemas.py
|   |-- test_fakes.py
|   `-- test_fixture_server.py
|-- build_windows.py
|-- build_single_exe.py
|-- dev_environment.py
|-- .npmrc
|-- package.json
|-- requirements-build.txt
|-- vite.config.js
|-- worldmedia_downloads.py
|-- worldmedia_ffmpeg.py
|-- worldmedia_jobs.py
|-- worldmedia_catalog.py
|-- worldmedia_media.py
|-- worldmedia_native.py
|-- worldmedia_recording.py
|-- worldmedia_runtime.py
|-- worldmedia_security.py
|-- worldmedia_theme.py
|-- worldmedia_server.py
`-- README.md
```

## Important Files

| Path | Purpose |
|---|---|
| `worldmedia_native.py` | Windows desktop entry point. Starts the local server and opens WebView2. |
| `worldmedia_theme.py` | Validated pywebview bridge and Windows DWM caption-color integration. |
| `worldmedia_server.py` | Local HTTP server, static frontend host, allowlisted CORS proxy, shutdown API. |
| `worldmedia_security.py` | Local control authentication, bounded JSON, safe filenames, atomic reservations, and redaction. |
| `worldmedia_runtime.py` | Portable/state/download/tool root selection and atomic writability probes. |
| `worldmedia_jobs.py` | Thread-safe capture job registry, limits, transitions, and shutdown coordination. |
| `worldmedia_catalog.py` | Bounded persistent catalog cache, safe dynamic feed/PeerTube/Owncast resolvers, and opaque artwork registry. |
| `worldmedia_media.py` | DNS-pinned same-origin media relay, opaque registrations, and safe HLS/DASH rewriting. |
| `worldmedia_ffmpeg.py` | Verified FFmpeg discovery, capability probes, managed acquisition, and lifecycle. |
| `worldmedia_downloads.py` | Original finite-media downloads, safe resume, atomic publication, and folder access. |
| `src/lib/capture-client.js` | Authenticated control client and frontend relay lifecycle. |
| `src/lib/catalog-scheduler.js` | Fair global/provider metadata scheduling, retry cooldowns, visibility pause, cancellation, and deduplication. |
| `src/lib/catalog-client.js` | Authenticated semantic catalog and opaque artwork control client. |
| `src/lib/artwork.js` | Prioritized, deduplicated, retryable conversion from provider image metadata to opaque local asset URLs, with playback-aware concurrency. |
| `src/modes/library/catalog-store.js` | Bounded resident catalog, stable merge/update identities, snapshot replacement, and eviction pins. |
| `src/modes/library/snapshots.js` | Independent live-snapshot refresh, stale-cache state, reconciliation, and teardown. |
| `src/lib/themes.js` | Persisted appearance catalog, DOM theme application, and native-caption synchronization. |
| `src/lib/dash-player.js` | Lazy dash.js playback lifecycle, MSE checks, errors, and deterministic cleanup. |
| `src/lib/download-client.js` | Opaque registration, finite-download start/status/cancel, and open-folder client. |
| `src/` | Vite frontend source. |
| `src/lib/media-capabilities.js` | Pure download/record capability and manifest-delivery resolver. |
| `src/lib/eq-store.js` | Versioned global, favorite, and custom-preset EQ persistence contract. |
| `src/lib/recording-profiles.js` | Validated compact, balanced, and high capture-quality profiles. |
| `frontend/` | Built frontend copied into the portable distribution. |
| `public/THIRD_PARTY_NOTICES.txt` | Versioned runtime/library notices copied into the packaged localhost frontend. |
| `tests/` | Deterministic adapter, cursor, player, capability, storage, timeout, and retry regressions. |
| `tests/accessibility.test.js` | Keyboard state, dialog semantics, live-region, focus, reduced-motion, and forced-colors contract. |
| `tests_python/` | Local media fixtures, frozen backend schemas, and deterministic Python seams. |
| `tests_python/single_exe_real_smoke.py` | Opt-in real FFmpeg/download/MP3/MP4 gate that executes the classic one-file artifact under isolated roots. |
| `screenshots/` | Versioned README and documentation screenshots. |
| `build_windows.py` | Builds the signed-runtime portable folder and release ZIP. |
| `build_single_exe.py` | Builds the classic unsigned one-file `dist\WorldMediaWindows.exe` with the current frontend, icon, and WebView bridge. |
| `assets/` | App icon, Windows metadata, and embedded-runtime launcher assets. |
| `docs/PROVIDERS.md` | All eleven public endpoints, cache/refresh rules, limitations, and content/retry behavior. |
| `docs/RELEASE_NOTES_0.1.2.md` | Prepared GitHub release notes for the `v0.1.2` tag and both release assets. |
