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
|   |-- wiki/
|   |-- BUILD_WINDOWS.md
|   |-- FILE_TREE.md
|   |-- PROVIDERS.md
|   |-- RELEASE_CHECKLIST.md
|   |-- RELEASE_NOTES_0.1.2.md
|   |-- RELEASE_NOTES_0.1.3.md
|   |-- RELEASE_NOTES_0.1.4.md
|   |-- RELEASE_NOTES_0.1.5.md
|   |-- RELEASE_NOTES_0.1.6.md
|   |-- RELEASE_NOTES_0.1.7.md
|   |-- RELEASE_NOTES_0.1.8.md
|   |-- RELEASE_NOTES_0.1.9.md
|   |-- RELEASE_NOTES_0.1.10.md
|   |-- RELEASE_NOTES_0.1.11.md
|   |-- RELEASE_RECORD_0.1.3.md
|   |-- RELEASE_RECORD_0.1.4.md
|   |-- RELEASE_RECORD_0.1.5.md
|   |-- RELEASE_RECORD_0.1.6.md
|   |-- RELEASE_RECORD_0.1.7.md
|   |-- RELEASE_RECORD_0.1.8.md
|   |-- RELEASE_RECORD_0.1.9.md
|   |-- RELEASE_RECORD_0.1.10.md
|   |-- RELEASE_RECORD_0.1.11.md
|   |-- REPOSITORY_SETUP.md
|   `-- WIKI.md
|-- frontend/
|   |-- assets/
|   `-- index.html
|-- public/
|   `-- THIRD_PARTY_NOTICES.txt
|-- screenshots/
|   |-- updated screenshots/
|   |-- v0.1.3/
|   |-- 1.PNG
|   |-- 2.PNG
|   |-- 3.PNG
|   |-- 4.PNG
|   `-- 5.PNG
|-- scripts/
|   |-- import_psychedelia.mjs
|   `-- prepare_wiki.py
|-- src/
|   |-- adapters/
|   |-- lib/
|   |-- modes/
|   |-- styles/
|   |-- vendor/
|   |-- visualizer/
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
|-- worldmedia_backup.py
|-- worldmedia_downloads.py
|-- worldmedia_ffmpeg.py
|-- worldmedia_icy.py
|-- worldmedia_jobs.py
|-- worldmedia_catalog.py
|-- worldmedia_media.py
|-- worldmedia_native.py
|-- worldmedia_playlists.py
|-- worldmedia_recording.py
|-- worldmedia_runtime.py
|-- worldmedia_security.py
|-- worldmedia_songlog.py
|-- worldmedia_station_images.py
|-- worldmedia_theme.py
|-- worldmedia_server.py
`-- README.md
```

## Important Files

| Path | Purpose |
|---|---|
| `worldmedia_native.py` | Windows desktop entry point. Chooses the local port (waiting up to 8 seconds for a busy port that answers as World Media), starts the local server and opens WebView2. |
| `worldmedia_theme.py` | Validated pywebview bridge and Windows DWM caption-color integration. |
| `worldmedia_server.py` | Local HTTP server, static frontend host, allowlisted CORS proxy, shutdown API. |
| `worldmedia_security.py` | Local control authentication, bounded JSON, safe filenames, and redaction. |
| `worldmedia_runtime.py` | Portable/state/download/tool root selection and atomic writability probes. |
| `worldmedia_jobs.py` | Thread-safe capture job registry, limits, transitions, and shutdown coordination. |
| `worldmedia_catalog.py` | Bounded persistent catalog cache, safe dynamic feed/PeerTube/Owncast resolvers, and opaque artwork registry. |
| `worldmedia_media.py` | DNS-pinned same-origin media relay, opaque registrations, and safe HLS/DASH rewriting. |
| `worldmedia_ffmpeg.py` | Verified FFmpeg discovery, capability probes, managed acquisition, and lifecycle. |
| `worldmedia_downloads.py` | Original finite-media downloads, safe resume, atomic publication, and folder access. |
| `worldmedia_backup.py` | Settings backup ZIP: copies of the saved state files plus universal `.m3u8` playlists, written to the downloads folder. |
| `worldmedia_icy.py` | Shoutcast/Icecast song titles: when the relay asks a station for them, removing the metadata blocks from the audio, and cleaning the title. |
| `worldmedia_songlog.py` | The song log file (`state/song-log.json`): ordered writes, safe handling of an unreadable file, and the CSV export. |
| `worldmedia_station_images.py` | The user's `station-images` folder: safe listing (with the files that were not used and why), station-name matching, and serving verified pictures. |
| `src/lib/capture-client.js` | Authenticated control client and frontend relay lifecycle. |
| `src/lib/catalog-scheduler.js` | Fair global/provider metadata scheduling, retry cooldowns, visibility pause, cancellation, and deduplication. |
| `src/lib/catalog-client.js` | Authenticated semantic catalog and opaque artwork control client. |
| `src/lib/artwork.js` | Prioritized, deduplicated, retryable conversion from provider image metadata to opaque local asset URLs, with playback-aware concurrency. |
| `src/modes/library/catalog-store.js` | Bounded resident catalog, stable merge/update identities, snapshot replacement, and eviction pins. |
| `src/modes/library/snapshots.js` | Independent live-snapshot refresh, stale-cache state, reconciliation, and teardown. |
| `src/lib/live-load.js` | Tuner/Grid progressive source loading and per-source time limits. |
| `src/lib/initials.js` | Initials and stable colours for items without artwork. |
| `src/lib/playlist-drop.js` | Drag-and-drop import of local M3U playlists; keeps other dropped files from being opened by Windows. |
| `src/lib/video-picture.js` | Decides whether the floating video is shown: at once for TV/video, only with a picture for radio/audio. |
| `src/lib/themes.js` | Persisted appearance catalog, DOM theme application, and native-caption synchronization. |
| `src/lib/dash-player.js` | Lazy dash.js playback lifecycle, MSE checks, errors, and deterministic cleanup. |
| `src/lib/download-client.js` | Opaque registration, finite-download start/status/cancel, and open-folder client. |
| `src/lib/backup.js` | Settings "Back up my data" button: saves the profile first, then asks the backend for the backup ZIP. |
| `src/lib/favorites-order.js` | Favorites display order ("My order" or A-Z), shared by the Library and the Tuner. |
| `src/lib/favorite-groups.js` | Favorites categories: make, rename, delete and assign them, with their own saved key. |
| `src/modes/library/favorite-categories.js` | The category buttons in Favorites, and the form to make, rename and delete a category. |
| `src/modes/library/card-category.js` | The category (tag) button on each favorite card, and its menu. |
| `src/lib/live-resume.js` | Automatic reconnect of a live stream that drops after playing: retry schedule and ten-minute limit. |
| `src/lib/relay-memory.js` | Remembers the playback relay across a page reload, so the next page can release it. |
| `src/lib/resolve-message.js` | Plain wording for an item whose details could not be looked up before play, for example one from a removed source. |
| `src/lib/now-playing.js` | Follows the song title a station announces while a live audio item plays. |
| `src/lib/song-log.js` | The song log: keeps the newest 500 songs and saves them to the data folder. |
| `src/lib/song-log-panel.js` | The Song log panel opened from the top bar: list, Copy, Remove, Save to file, and Clear log. |
| `src/styles/song-log.css` | Styles for the Song log panel. |
| `src/lib/station-images.js` | Station images: the list from the backend, name matching, and the Settings controls. |
| `src/lib/stream-quality.js` | The format and bitrate label for Radio Browser stations. |
| `src/lib/other-streams.js` | The rule that decides which Radio Browser entries are listed as other streams of a station. |
| `src/modes/library/other-streams.js` | The **Other streams** button and list in the Library detail panel. |
| `src/lib/audio-signal.js` | Reads the sound for visuals from the audio engine's side tap, once per frame for every listener; runs only while something audible plays and the window is visible. |
| `src/lib/player-meter.js` | The LED-style sound meter in the player bar (14 bars), switched by Settings > Appearance > Sound meter in the player bar. |
| `src/lib/tuner-card-size.js` | The Tuner card size choice (Small, Medium, Large) and which sizes show pictures. |
| `src/lib/tuner-card-art.js` | Pictures on Medium and Large Tuner cards: initials first, pictures only for cards in view once the strip has stopped moving. |
| `src/lib/favorite-migration.js` | After a playlist is imported again, moves the favorites of channels that changed between radio and TV to the new channel, keeping place, category and equalizer. |
| `src/lib/visualizer-settings.js` | The Visualizer's saved choices (quality, frame rate, brightness, scene, shuffle, effects, overlays, favourites, notice) and their checks. Small on purpose: it is in the main bundle. |
| `src/modes/visualizer.js` | The Visualizer tab's shell: loads the Visualizer when the tab first opens and tears it down when the tab closes. |
| `src/visualizer/index.js` | The Visualizer's panel and wiring: scene, look, shuffle, effects, overlays, picture, the photosensitivity notice, and the step-down note. |
| `src/visualizer/scenes.js` | The table of scenes (name, category, cost badge, sound links), the flash-safety caps, and `HELD_SCENES`, the scenes that are not offered. With `scene-list.js` (the searchable list), `scene-renderer.js` (WebGL drawing), `scene-switcher.js`, `looks.js` and `transition.js`. |
| `src/visualizer/reactor.js`, `loop.js`, `mood.js` | The sound side: Psychedelia's Beat Reactor fed from the shared signal, when to draw, and the music's mood. |
| `src/visualizer/flash-limiter.js` | The flash limiter that every sound-derived value passes: at most three large pulses a second, shared by everything. |
| `src/visualizer/fx-catalog.js`, `fx-chain.js`, `fx-shuffle.js`, `fx-reactions.js` | Post effects: the table of the 38 offered, the graphics chain that draws them, the shuffle, and the limited beat reactions. |
| `src/visualizer/overlay-catalog.js`, `overlay-layer.js`, `overlay-patterns.js`, `overlay-shuffle.js` | Overlays: the table of the 25 offered and their blend-ins, the canvas that draws them, the seven patterns written for this app, and the shuffle. |
| `src/visualizer/shuffle.js`, `favourites.js`, `step-down.js`, `hud.js`, `notice.js`, `size.js`, `visualizer.js`, `visualizer.css` | The scene shuffle, favourites, the automatic step-down, the buttons over the picture, the photosensitivity notice, drawing size, the chunk's entry and its styles. |
| `src/visualizer/vendor/psychedelia/` | Code copied from Psychedelia Studio (same author, MIT): 76 files in `effects/` (the scenes and their helpers), 5 in `engine/`, `manifest.json` (each file's source and SHA-256) and licence files. Generated: do not edit by hand. |
| `scripts/import_psychedelia.mjs` | Copies the used parts of Psychedelia Studio into the vendor folder and writes the manifest. `--check-drift` lists what changed upstream. |
| `src/modes/about-credits.js`, `src/modes/about-credits-load.js` | The About page's **Visualizer credits**, built from the manifest's borrowed list and loaded as their own chunk. |
| `CREDITS.md` | Credits for catalogs and libraries, and for the Visualizer's copied and borrowed code. |
| `src/` | Vite frontend source. |
| `src/lib/media-capabilities.js` | Pure download/record capability and manifest-delivery resolver. |
| `src/lib/eq-store.js` | Versioned global, favorite, and custom-preset EQ persistence contract. |
| `src/lib/recording-profiles.js` | Validated compact, balanced, and high capture-quality profiles. |
| `frontend/` | Built frontend copied into the portable distribution. |
| `public/THIRD_PARTY_NOTICES.txt` | Versioned runtime/library notices copied into the packaged localhost frontend. |
| `tests/` | Deterministic adapter, cursor, player, capability, storage, timeout, and retry regressions. |
| `tests/accessibility.test.js` | Keyboard state, dialog semantics, live-region, focus, reduced-motion, and forced-colors contract. |
| `tests_python/` | Local media fixtures, frozen backend schemas, and deterministic Python seams. |
| `tests_python/production_ui_harness.py` | Opt-in real-Edge acceptance run of the exact production bundle (see its docstring). |
| `tests_python/single_exe_real_smoke.py` | Opt-in real FFmpeg/download/MP3/MP4 gate that executes the classic one-file artifact under isolated roots. |
| `tests/favorites-order.test.js`, `tests/favorite-groups.test.js`, `tests/favorite-categories-ui.test.js` | Favorites order and categories: sorting and moving, saved data, and the Library controls. |
| `tests/slice1-mute-volume.test.js`, `tests/slice2-tuner-strip.test.js` | Crossed-out speaker and volume percentage; the Tuner strip centring and dial glow. |
| `tests/slice4-pls-import.test.js`, `tests/slice4-xspf-import.test.js`, `tests/slice5-star-all.test.js` | `.pls` and `.xspf` playlist import, and **Star all**. |
| `tests/now-playing.test.js`, `tests/now-playing-player.test.js`, `tests/song-log.test.js`, `tests/song-log-panel.test.js` | Song title following, its use in the player bar, and the song log and its panel. |
| `tests/live-resume.test.js`, `tests/live-resume-capture.test.js`, `tests/live-resume-player.test.js` | Live stream reconnect: the retry schedule, the capture bar text, and the player. |
| `tests/station-images.test.js`, `tests/station-images-cards.test.js`, `tests/station-images-views.test.js`, `tests/fixtures/station-image-names.json` | Station images: matching (shared cases in the fixture), cards, and the other views. |
| `tests/other-streams.test.js`, `tests/backup.test.js` | **Other streams** listing, and the Settings backup button. |
| `tests/retired-source.test.js`, `tests/library-retry-holds.test.js` | The removed Library of Congress source, and Library retry and hold behaviour. |
| `tests/relay-cleanup.test.js`, `tests/profile-write-queue.test.js` | Relay release after rejected starts and reloads, and ordered profile saves and Clear cache. |
| `tests_python/test_icy_metadata.py`, `tests_python/test_songlog.py`, `tests_python/test_station_images.py`, `tests_python/test_backup.py` | The Python side of song titles, the song log, station pictures and the backup ZIP. |
| `tests_python/test_favorite_groups_profile.py`, `tests_python/test_playlists_pls.py`, `tests_python/test_playlists_xspf.py`, `tests_python/test_relay_lifecycle.py` | The split profile files, `.pls` and `.xspf` import, and relay release for downloads and recordings. |
| `tests/station-images-fit.test.js`, `tests/issue6-steady-dial.test.js` | Issue #6: station pictures shown whole, and a Tuner dial that keeps its size. |
| `tests/sound-meter.test.js` | The sound signal and the player-bar sound meter. |
| `tests/tuner-card-size.test.js`, `tests/tuner-card-art-stop.test.js` | Tuner card sizes, knob text, and the card pictures (when they load and stop). |
| `tests/issue6-stations-and-pictures.test.js`, `tests_python/test_issue6_stations.py` | Issue #6 and discussion #8 (v0.1.11): favorites on the dial, Add as Auto, favorites following a re-import, station pictures for names with forbidden characters, the list of unused pictures, Move to bottom, Remove all favorites, and the local port a second copy would share. |
| `tests/visualizer.test.js`, `tests/visualizer-signal.test.js`, `tests/visualizer-slice2.test.js` to `tests/visualizer-slice7.test.js`, `tests/visualizer-tuning.test.js`, `tests/visualizer-flash-lifecycle.test.js`, `tests/visualizer-real-window.test.js` | The Visualizer: the vendored files against their manifest, the sound signal, scenes and looks, shuffle, favourites, step-down, effects, overlays, the flash limiter, and the tab in a window. |
| `tests/about-credits.test.js` | The About page's Visualizer credits, and that `CREDITS.md` and the notices name every borrowed piece. |
| `tests/helpers/audio-sim.js`, `scene-luminance.js`, `signal-harness.js`, `visualizer-fakes.js` | Test helpers: simulated music for the analyser, a CPU recompute of two scenes' brightness, a clock and timer simulation, and fake graphics, DOM and window objects. |
| `tests/helpers/visualizer-flash-check.mjs` and `.py`, `visualizer-fx-check.mjs` and `.py`, `visualizer-fx-check-page.js` | Checks run by hand, not by `npm test`: they draw scenes, effects and overlays in Chromium and report the largest frame-to-frame step of light. |
| `screenshots/` | Versioned README and documentation screenshots. |
| `build_windows.py` | Builds the signed-runtime portable folder and release ZIP. |
| `build_single_exe.py` | Builds the classic unsigned one-file `dist\WorldMediaWindows.exe` with the current frontend, icon, and WebView bridge. |
| `assets/` | App icon, Windows metadata, and embedded-runtime launcher assets. |
| `docs/PROVIDERS.md` | All ten public endpoints, cache/refresh rules, limitations, and content/retry behavior. |
| `docs/RELEASE_NOTES_0.1.10.md` | GitHub release notes for the `v0.1.10` tag and its release assets. |
| `docs/RELEASE_NOTES_0.1.11.md` | GitHub release notes for the `v0.1.11` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.11.md` | What was checked for v0.1.11, with artifact hashes and limits. |
