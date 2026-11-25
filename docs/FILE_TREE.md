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
|   |-- RELEASE_NOTES_0.1.12.md
|   |-- RELEASE_NOTES_0.1.13.md
|   |-- RELEASE_NOTES_0.1.14.md
|   |-- RELEASE_NOTES_0.1.15.md
|   |-- RELEASE_NOTES_0.1.16.md
|   |-- RELEASE_NOTES_0.1.17.md
|   |-- RELEASE_RECORD_0.1.3.md
|   |-- RELEASE_RECORD_0.1.4.md
|   |-- RELEASE_RECORD_0.1.5.md
|   |-- RELEASE_RECORD_0.1.6.md
|   |-- RELEASE_RECORD_0.1.7.md
|   |-- RELEASE_RECORD_0.1.8.md
|   |-- RELEASE_RECORD_0.1.9.md
|   |-- RELEASE_RECORD_0.1.10.md
|   |-- RELEASE_RECORD_0.1.11.md
|   |-- RELEASE_RECORD_0.1.12.md
|   |-- RELEASE_RECORD_0.1.13.md
|   |-- RELEASE_RECORD_0.1.14.md
|   |-- RELEASE_RECORD_0.1.15.md
|   |-- RELEASE_RECORD_0.1.16.md
|   |-- RELEASE_RECORD_0.1.17.md
|   |-- REPOSITORY_SETUP.md
|   `-- WIKI.md
|-- frontend/
|   |-- assets/
|   `-- index.html
|-- public/
|   `-- THIRD_PARTY_NOTICES.txt
|-- screenshots/
|   `-- v0.1.14/
|-- scripts/
|   |-- import_psychedelia.mjs
|   |-- look_darkness.mjs
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
|-- worldmedia_playlist_tables.py
|-- worldmedia_playlist_export.py
|-- worldmedia_processor.py
|-- worldmedia_recording.py
|-- worldmedia_runtime.py
|-- worldmedia_security.py
|-- worldmedia_single_instance.py
|-- worldmedia_songlog.py
|-- worldmedia_starred.py
|-- worldmedia_station_images.py
|-- worldmedia_stream_probe.py
|-- worldmedia_stream_title.py
|-- worldmedia_theme.py
|-- worldmedia_server.py
`-- README.md
```

## Important Files

| Path | Purpose |
|---|---|
| `worldmedia_native.py` | Windows desktop entry point. Claims the data folder (one copy per data folder), chooses the local port (waiting up to 8 seconds for a busy port that answers as World Media), starts the local server and opens WebView2. |
| `worldmedia_single_instance.py` | One running copy per data folder: a named mutex per folder, the request that brings the running copy's window to the front, and the wait for a copy that is closing. |
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
| `worldmedia_icy.py` | Shoutcast/Icecast song titles: when the relay asks a station for them, removing the metadata blocks from the audio, and cleaning the title; and the aligner that starts a live AAC stream at its first whole frame. |
| `worldmedia_songlog.py` | The song log file (`state/song-log.json`): ordered writes, safe handling of an unreadable file, and the CSV export. |
| `worldmedia_station_images.py` | The user's `station-images` folder: safe listing (with the files that were not used and why), station-name matching, and serving verified pictures. |
| `worldmedia_starred.py` | Starred songs (`state/starred-songs.json`): ordered writes, safe handling of an unreadable file, and the **Save as text** and **Save as CSV** exports. |
| `worldmedia_playlist_tables.py` | JSON and CSV channel lists, turned into the M3U form every playlist is stored in, with limits on size and entries. |
| `worldmedia_playlist_export.py` | Writes the current Favorites or My Playlists selection as M3U8 or JSON and counts entries it cannot export. |
| `worldmedia_stream_title.py` | Reads the current song title of a radio favorite with limits on time, bytes and simultaneous reads. |
| `worldmedia_stream_probe.py` | A short, bounded look at two radio streams for **Pick the best stream: Auto (verified)**: what each says about itself (format, bitrate, name, song title); nothing is decoded or kept. |
| `worldmedia_processor.py` | The app's processor use (its own and its window's processes, as a share of the whole processor), read only when the Visualizer asks at Balanced or High. |
| `src/lib/capture-client.js` | Authenticated control client and frontend relay lifecycle. |
| `src/lib/catalog-scheduler.js` | Fair global/provider metadata scheduling, retry cooldowns, visibility pause, cancellation, and deduplication. |
| `src/lib/catalog-client.js` | Authenticated semantic catalog and opaque artwork control client; at most three slow catalogue requests (podcast feeds, PeerTube, Owncast) at a time. |
| `src/lib/artwork.js` | Prioritized, deduplicated, retryable conversion from provider image metadata to opaque local asset URLs, with playback-aware concurrency. |
| `src/modes/library/catalog-store.js` | Bounded resident catalog, stable merge/update identities, snapshot replacement, and eviction pins. |
| `src/modes/library/snapshots.js` | Independent live-snapshot refresh (read once at start, then only while the list is shown), stale-cache state, reconciliation, and teardown. |
| `src/modes/library/line-watch.js` | Notices that the connection is back after a drop and wakes the Library sources that are waiting. |
| `src/lib/live-load.js` | Tuner/Grid progressive source loading and per-source time limits. |
| `src/lib/initials.js` | Initials and stable colours for items without artwork. |
| `src/lib/playlist-drop.js` | Drag-and-drop import of local playlist files (`.m3u`, `.m3u8`, `.pls`, `.xspf`, `.json`, `.csv`); keeps other dropped files from being opened by Windows. |
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
| `src/lib/song-log-panel.js` | The Song log panel opened from the top bar: list, Copy, Remove, Save to file, and Clear log, and the **Starred songs** list with its searches, **Save as text** and **Save as CSV**. |
| `src/lib/starred-songs.js`, `src/lib/song-star.js` | Starred songs: the page's store (kept by the local server, at most 2,000) and the star on the player bar. |
| `src/lib/favorite-names.js`, `src/lib/favorite-rename.js` | Names of your own for favorites, kept apart from the favorites, and their removal when a favorite goes. |
| `src/lib/startup-tidy.js` | Once per start, after the profile is restored and before it is first saved: drops names and category assignments of stations that are no longer favorites. |
| `src/styles/song-log.css` | Styles for the Song log panel. |
| `src/lib/station-images.js` | Station images: the list from the backend, name matching, and the Settings controls. |
| `src/lib/stream-quality.js` | The format and bitrate label, and the audio types a station's reply names. |
| `src/lib/played-streams.js` | The format and bitrate each station played with (a cache of at most 1,000, removed by Clear cache), and the label shown for a station from them and from its directory. |
| `src/lib/volume-stepper.js` | The volume control (up, number, down) and the Tuner's Visualizer control: clicks, a held button, the wheel and the keys; and what a video's own volume controls changed. |
| `src/lib/other-streams.js` | The rule that decides which Radio Browser entries are listed as other streams of a station. |
| `src/modes/library/other-streams.js` | The **Other streams** button and list in the Library detail panel, and the **Auto (verified)** line. |
| `src/lib/best-stream.js`, `src/lib/media-failover.js`, `src/lib/start-failover.js` | **Pick the best stream**: ranking a station's listed streams, the best one's head start, and handing a stream that never begins to the next. |
| `src/lib/best-stream-auto.js`, `src/lib/stream-verify.js`, `src/lib/stream-lookups.js` | **Auto (verified)**: when the background checks run, the rules a better stream must pass, and the saved directory lookups. |
| `src/lib/processor-budget.js` | **Processor use**: the level, the limit, the quality steering, and what Balanced and High add (Very high, larger simulations). |
| `src/lib/audio-signal.js` | Reads the sound for visuals from the audio engine's side tap, once per frame for every listener; runs only while something audible plays and the window is visible. |
| `src/lib/player-meter.js` | The LED-style sound meter in the player bar (14 bars), switched by Settings > Appearance > Sound meter in the player bar; the Now Playing tab uses it with larger segments. |
| `src/modes/now-playing.js`, `src/styles/now-playing.css` | The Now Playing tab: the picture, name, category, song with star and Copy, stream details and a large sound meter over a blurred copy of the picture; everything it uses is removed when the tab closes. |
| `src/lib/play-clock.js` | How long the loaded item has been playing (only while its media advances, as player.js reports), for the Now Playing tab. |
| `src/lib/tuner-card-size.js` | The Tuner card size choice (Small, Medium, Large) and which sizes show pictures. |
| `src/lib/tuner-card-art.js` | Pictures on Medium and Large Tuner cards: initials first, pictures only for cards in view once the strip has stopped moving. |
| `src/lib/favorite-migration.js` | After a playlist is imported again, moves the favorites of channels that changed between radio and TV to the new channel, keeping place, category and equalizer. |
| `src/lib/visualizer-settings.js` | The Visualizer's saved choices (quality, frame rate, brightness, scene, shuffle, effects, overlays, Strobe style, slow drift, folded panel sections, favorites, notice) and their checks. Small on purpose: it is in the main bundle. |
| `src/modes/visualizer.js` | The Visualizer tab's shell: loads the Visualizer when the tab first opens and tears it down when the tab closes. |
| `src/visualizer/index.js` | The Visualizer's panel (sections with title bars that fold and say what is set) and wiring: scene, look, shuffle, effects, overlays, picture, the photosensitivity notice, and the step-down note. |
| `src/visualizer/scenes.js` | The table of scenes (name, category, cost badge, sound links), the flash-safety caps, and `HELD_SCENES`, the scenes that are not offered. It takes the line drawings, World Media's own scenes and Buddhabrot Lab from `line-scenes.js`, `own-scenes.js` and `accumulating-scenes.js`. With `scene-list.js` (the searchable list), `scene-renderer.js` (WebGL drawing), `scene-switcher.js`, `looks.js` (with the extra looks) and `transition.js` (cross-fades, stretched while Buddhabrot Lab's picture is prepared). |
| `src/visualizer/line-host.js`, `sim-host.js`, `shadertoy-adapter.js`, `density-host.js`, `density-worker.js` | Hosts for scenes that draw their own way: glowing line drawings, simulations and frame-feedback scenes, and Buddhabrot Lab's picture built in a worker. |
| `src/visualizer/own/`, `src/visualizer/own-scenes.js` | World Media's own scenes: Band Ridgelines, Sound Ring, Petal Bloom, Hex Weave and Contour Lines. |
| `src/visualizer/drift.js`, `swell.js`, `overlay-motion.js` | Slow drift: scene and effect settings moving with the music's bars, the music's slow swell, and the overlays' slow turn and sway. |
| `src/visualizer/spelling.js` | American spelling for names that come from Psychedelia (effects, their groups, looks); saved values are unchanged. |
| `src/visualizer/look-darkness.js`, `scripts/look_darkness.mjs` | Each look's darkness (0 bright to 1 dark) from a brightness check of every look; the script writes the table. Generated: do not edit by hand. |
| `src/visualizer/reactor.js`, `loop.js`, `mood.js` | The sound side: Psychedelia's Beat Reactor fed from the shared signal, when to draw, and the music's mood. |
| `src/visualizer/flash-limiter.js` | The flash limiter that every sound-derived value passes: at most three large pulses a second, shared by everything. |
| `src/visualizer/fx-catalog.js`, `fx-chain.js`, `fx-shuffle.js`, `fx-reactions.js` | Post effects: the table of the 39 offered, the graphics chain that draws them, the shuffle, and the limited beat reactions. |
| `src/visualizer/overlay-catalog.js`, `overlay-layer.js`, `overlay-patterns.js`, `overlay-shuffle.js` | Overlays: the table of the 26 offered and their blend-ins, the canvas that draws them, the eight patterns written for this app (Strobe among them), and the shuffle. |
| `src/visualizer/shuffle.js`, `favourites.js`, `step-down.js`, `hud.js`, `notice.js`, `size.js`, `visualizer.js`, `visualizer.css` | The scene shuffle, favourites, the automatic step-down, the buttons over the picture, the photosensitivity notice, drawing size, the chunk's entry and its styles. |
| `src/visualizer/vendor/psychedelia/` | Code copied from Psychedelia Studio (same author, MIT): 100 files in `effects/` (the scenes and their helpers), 9 in `engine/`, 1 in `workers/`, `manifest.json` (each file's source and SHA-256) and licence files. Generated: do not edit by hand. |
| `scripts/import_psychedelia.mjs` | Copies the used parts of Psychedelia Studio into the vendor folder and writes the manifest. `--check-drift` lists what changed upstream. |
| `src/modes/about-credits.js`, `src/modes/about-credits-load.js` | The About page's **Visualizer credits**, built from the manifest's borrowed list and loaded as their own chunk. |
| `CREDITS.md` | Credits for catalogs and libraries, and for the Visualizer's copied and borrowed code. |
| `src/` | Vite frontend source. |
| `src/lib/media-capabilities.js` | Pure download/record capability and manifest-delivery resolver. |
| `src/lib/eq-store.js` | Versioned global, favorite, and custom-preset EQ persistence contract. |
| `src/lib/eq-curve.js` | Normalizes preamp, band gain and Q for playback, presets and recording. |
| `src/lib/eq-stations.js` | Collects stations from Favorites and My Playlists for batch EQ assignment. |
| `src/lib/media-parts.js` | Loads audio tracks and chapters and builds the playback and download information for the selected part. |
| `src/lib/part-resume.js` | Keeps the saved track or chapter and playback position for audio items. |
| `src/lib/picture-panel.js` | Connects the Picture controls to the current video and saves the selected look and fit. |
| `src/lib/picture-settings.js` | Stores picture settings for all video or a saved channel and applies color and fit to video. |
| `src/lib/profile-storage.js` | Lists the browser keys copied to the saved profile and checks the shared size limit. |
| `src/lib/station-stream-addresses.js` | Stores and reads edited main and backup stream addresses for saved stations. |
| `src/lib/station-stream-edit.js` | Checks station ownership and validates new addresses before saving an edit. |
| `src/lib/top-tabs.js` | Applies **Tabs shown** and falls back to Library when the active tab is hidden. |
| `src/modes/library/favorite-title-scheduler.js` | Queues and refreshes song title reads for visible radio Favorites. |
| `src/modes/library/favorite-titles.js` | Shows song and performer on Favorites cards and the station text in a tooltip. |
| `src/modes/library/stream-addresses.js` | The **Stream address...** form for editing a station and ordering its backups. |
| `src/visualizer/dev-flags.js` | Reads Visualizer diagnostic switches when the tab opens. |
| `src/visualizer/flight-shading.js` | Adjusts the shading for DIFS Tunnel Flight and Hypercomplex Slice Flight. |
| `src/lib/recording-profiles.js` | Validated compact, balanced, and high capture-quality profiles. |
| `frontend/` | Built frontend copied into the portable distribution. |
| `public/THIRD_PARTY_NOTICES.txt` | Versioned runtime/library notices copied into the packaged localhost frontend. |
| `tests/` | Deterministic adapter, cursor, player, capability, storage, timeout, and retry regressions. |
| `tests/accessibility.test.js` | Keyboard state, dialog semantics, live-region, focus, reduced-motion, and forced-colors contract. |
| `tests_python/` | Local media fixtures, frozen backend schemas, and deterministic Python seams. |
| `tests_python/production_ui_harness.py` | Opt-in real-Edge acceptance run of the exact production bundle (see its docstring). |
| `tests_python/single_exe_real_smoke.py` | Opt-in real FFmpeg/download/MP3/MP4 gate that executes the classic one-file artifact under isolated roots. |
| `tests/favorites-order.test.js`, `tests/favorite-groups.test.js`, `tests/favorite-categories-ui.test.js` | Favorites order and categories: sorting, moving and dragging, saved data, and the Library controls. |
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
| `tests/visualizer-lines.test.js`, `tests/visualizer-own-scenes.test.js`, `tests/visualizer-accumulating.test.js`, `tests/visualizer-extra-looks.test.js`, `tests/visualizer-drift.test.js`, `tests/visualizer-very-high.test.js`, `tests/visualizer-american-spelling.test.js` | The Visualizer's line drawings, own scenes, scenes that build their picture (Buddhabrot Lab), extra looks, slow drift, Very high quality, and American spelling. |
| `tests/starred-songs.test.js`, `tests_python/test_starred_songs.py` | Starred songs: the store, the panel, the server file and the exports. |
| `tests/favorite-names.test.js`, `tests_python/test_favorite_names.py` | Names of your own for favorites: where they are shown, backups, and lookups under the station's own name. |
| `tests/playlist-json-csv.test.js`, `tests_python/test_playlists_tables.py` | `.json` and `.csv` playlist import. |
| `tests/best-stream.test.js`, `tests/best-stream-auto.test.js`, `tests_python/test_stream_probe.py` | Pick the best stream: ranking, the hand-over to the next stream, the Auto checks and the server's look at two streams. |
| `tests/processor-budget.test.js`, `tests/processor-extras.test.js`, `tests/visualizer-processor-use.test.js`, `tests_python/test_processor.py` | Processor use: levels and limit, the steering, Very high and the larger simulations, and the server's reading. |
| `tests/paging-guard.test.js`, `tests/library-slow-retry.test.js`, `tests/library-line-watch.test.js` | Library catalog retries: the wait, the slow retry after two failures, a refused page, and the wake-up when the connection is back. |
| `tests/http-outside-gate.test.js`, `tests/iptv-radio-robustness.test.js`, `tests/live-source-retry.test.js` | The limit of four catalog requests at a time, the iptv-org and Radio Browser loading rules, and the Tuner and Grid retry of a source that failed. |
| `tests/adapter-playable-picks.test.js`, `tests_python/test_podcast_enclosures.py`, `tests_python/test_download_content_types.py` | Which file of an item is played: Internet Archive, Wikimedia Commons, Radio Browser and LibriVox picks, podcast episode formats, and sound downloads labelled as video. |
| `tests_python/test_connect_first.py` | Connecting to a host with several addresses: all tried together, IPv4 first, the last good one remembered. |
| `tests/played-streams.test.js` | The format and bitrate stations played with: reading them from the relay's reply, remembering them once a start has played, the label, and where it shows. |
| `tests/volume-stepper.test.js`, `tests/volume-sleep-fade.test.js` | The volume control (clicks, hold, wheel, keys, limits), a video's own volume controls, and the volume set during a sleep-timer fade. |
| `tests/tuner-strip-wheel.test.js`, `tests/tuner-viz-level.test.js` | The mouse wheel over the Tuner's station strip, and the Visualizer strength control with its Settings switch. |
| `tests_python/test_adts_align.py` | Starting a live AAC stream at its first whole frame, and passing live audio on as it arrives. |
| `tests_python/test_single_instance.py` | One copy per data folder: the claim, the request to bring the window forward, a killed copy, racing starts, and the window and windowless starts. |
| `tests/about-credits.test.js` | The About page's Visualizer credits, and that `CREDITS.md` and the notices name every borrowed piece. |
| `tests/helpers/audio-sim.js`, `scene-luminance.js`, `signal-harness.js`, `visualizer-fakes.js` | Test helpers: simulated music for the analyser, a CPU recompute of two scenes' brightness, a clock and timer simulation, and fake graphics, DOM and window objects. |
| `tests/helpers/visualizer-flash-check.mjs` and `.py`, `visualizer-fx-check.mjs` and `.py`, `visualizer-fx-check-page.js` | Checks run by hand, not by `npm test`: they draw scenes, effects and overlays in Chromium and report the largest frame-to-frame step of light. |
| `tests/eq-stations.test.js` | Batch EQ assignments and their removal when the last saved station is removed. |
| `tests/favorite-title-scheduler.test.js` | Song title read limits, refresh timing and cancellation. |
| `tests/favorite-titles.test.js` | Song and performer text, station tooltips and when Favorites reads titles. |
| `tests/fixtures/archive-audio-parts.json` | Internet Archive metadata with tracks and alternate files. |
| `tests/fixtures/librivox-parts.xml` | LibriVox RSS with chapters in playback order. |
| `tests/library-sidebar.test.js` | Disabled source order, dimming and re-enabling in the Library. |
| `tests/multi-part-items.test.js` | Track and chapter ordering, resume, auto-advance, detail controls and downloads. |
| `tests/picture-settings.test.js` | Picture scope, filter and fit, saved settings and live video timeline controls. |
| `tests/station-stream-addresses.test.js` | Stream address validation, edit controls, failover order and saved profile behavior. |
| `tests/top-tabs.test.js` | Tab visibility, Library fallback and settings persistence. |
| `tests/visualizer-release.test.js` | Held scenes, warped dissolves and DIFS Tunnel Flight brightness. |
| `tests_python/test_part_resume_profile.py` | Track and chapter bookmarks in the extra profile and their removal on cache clear. |
| `tests_python/test_playlist_export.py` | Export and re-import, unique filenames, skipped items and safe Downloads paths. |
| `tests_python/test_station_stream_addresses.py` | Stream address validation, saved profile and backups. |
| `tests_python/test_stream_title.py` | Bounded radio title reads and their cancellation and connection rules. |
| `screenshots/` | Versioned README and documentation screenshots and short GIF demos. |
| `build_windows.py` | Builds the signed-runtime portable folder and release ZIP. |
| `build_single_exe.py` | Builds the classic unsigned one-file `dist\WorldMediaWindows.exe` with the current frontend, icon, and WebView bridge. |
| `assets/` | App icon, Windows metadata, and embedded-runtime launcher assets. |
| `docs/PROVIDERS.md` | All ten public endpoints, cache/refresh rules, limitations, and content/retry behavior. |
| `docs/RELEASE_NOTES_0.1.10.md` | GitHub release notes for the `v0.1.10` tag and its release assets. |
| `docs/RELEASE_NOTES_0.1.11.md` | GitHub release notes for the `v0.1.11` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.11.md` | What was checked for v0.1.11, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.12.md` | GitHub release notes for the `v0.1.12` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.12.md` | What was checked for v0.1.12, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.13.md` | GitHub release notes for the `v0.1.13` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.13.md` | What was checked for v0.1.13, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.14.md` | GitHub release notes for the `v0.1.14` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.14.md` | What was checked for v0.1.14, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.15.md` | GitHub release notes for the `v0.1.15` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.15.md` | What was checked for v0.1.15, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.16.md` | GitHub release notes for the `v0.1.16` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.16.md` | What was checked for v0.1.16, with artifact hashes and limits. |
| `docs/RELEASE_NOTES_0.1.17.md` | GitHub release notes for the `v0.1.17` tag and its release assets. |
| `docs/RELEASE_RECORD_0.1.17.md` | What was checked for v0.1.17, with artifact sizes and hashes. |
