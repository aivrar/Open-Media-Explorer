# Changelog

## 0.1.7 - 2026-11-10

- Dropping a local `.m3u`/`.m3u8` file on the window imports it into My
  Playlists, the same as **Import M3U**, instead of Windows opening the file in
  Notepad (issue #5). Dropped on the Tuner, new channels default to the band the
  dial is on. Other dropped files are ignored with a short message.
- Radio and audio items whose stream has no picture (audio-only HLS or DASH)
  no longer open an empty video square. TV and video items are unchanged.
- Tuner: the station strip under the dial now keeps the current station in
  view, centred where possible, instead of letting it scroll out of sight.
- Library sidebar: the "By archive" heading is hidden when every source is
  switched off.

## 0.1.6 - 2026-11-10

- Sources switched off in Settings are left out of the Library sidebar instead
  of staying in the list greyed out (issue #4).
- Tuner: the mouse wheel now turns the dial, one station per notch; the station
  is tuned when the wheel comes to rest.
- Tuner: dragging the dial across the 9 o'clock position no longer jumps 30
  stations.
- The floating video grows with the window (320 px wide on a 1080p-wide window,
  up to 640 px at 4K), and a button in its corner switches to a larger size;
  the choice is remembered.
- Fixed the managed FFmpeg install in Settings. The provider's GitHub project
  moved from `BtbN/FFmpeg-Builds` to `FFmpeg-Builds/FFmpeg-Builds`, and the app
  refused the new address ("GitHub release repository identity is invalid").
  Existing FFmpeg installs were not affected.

## 0.1.5 - 2026-11-08

- Fixed the portable ZIP not opening a window (issue #3). The ZIP was missing
  two window-component runtime folders that pywebview checks for at startup.
  The app's own bundled .NET DLLs are also now unblocked when they were
  extracted from a downloaded zip, which Windows otherwise refused to load.
  Affected the portable ZIP since 0.1.2; the single EXE was not affected.
- A portable startup failure now exits cleanly and is written to
  `logs\native.log`, instead of leaving a hidden process running.

## 0.1.4 - 2026-11-08

- Library opens on Favorites when you have saved items (the full catalog still
  loads in the background for All Sources).
- Tuner: new "★ My favorites" choice in the Source menu puts only your starred
  stations on the dial; the choice is remembered.
- Favorites and My Playlists use compact cards, so about three times as many
  saved items fit on screen.
- Tuner marks your starred stations with ★ in the station strip and on the dial.
- Simpler cards and sidebar by default: source status labels (Pull/Wait/Done/
  Live/Stale), boxed source badges, and license notes are hidden; a source that
  needs attention shows an amber dot, and hovering a source shows its status.
  Settings → Appearance → "Show technical source details" restores the full view.
- Tuner and Grid show stations as each source answers instead of waiting for
  the slowest one, and a source that does not answer within 20 seconds is marked
  unavailable rather than holding the view on "Loading".
- More station logos appear: .ico favicons are converted to PNG, and common
  serving mistakes are repaired (images labelled as generic downloads, and
  extra bytes after the end of a PNG or JPEG). SVG logos and web pages returned
  in place of an image are still refused.
- Items without artwork show their initials on a coloured square instead of a
  grey icon, so saved lists are easier to scan.
- Tuner shows the station's place in the list ("12 of 80") instead of a made-up
  FM frequency that changed whenever the list reloaded.
- Tuner dial text is readable in the light theme.
- The window title bar now starts in the app's saved theme and repaints right
  away on Windows 10, instead of showing white until focus changed; Windows
  "settings changed" broadcasts no longer reset it to the Windows app theme.
- The Shutdown button is a quiet outline that turns red on hover, instead of a
  bright red button.
- Short HLS clips that are fully buffered start at once instead of waiting up to
  30 seconds for a six-second playback cushion they can never build.
- Update Vite to 8.3.6 (development server advisory); npm audit reports no
  vulnerabilities.
- Repository cleanup: remove completed planning/research logs, duplicate
  screenshots, one-off phase probes, and small unused code; refresh the user
  guide, file tree, and acceptance-harness instructions.

## 0.1.3 - 2026-10-07

- Keep the playlist toolbar and Add link form usable in narrow windows.
- Update vulnerable transitive build dependencies; npm audit reports no vulnerabilities.
- Keep the previous Favorites list and star state if saving fails; display an
  accessible warning for failed Favorites/settings saves and native profile backups.

- Add a friendly Add link form for named direct TV/radio streams or online M3U
  playlists, including safe remote fetching and relative stream/logo URLs.
- Acknowledge shutdown before background cleanup and exit; prevent a UI cleanup
  error from displaying Retry after the server already accepted the request.

- Add local M3U/M3U8 live-channel imports in Library's My Playlists, with portable
  native storage, playlist selection, safe artwork/playback, deduplication, and
  explicit replacement/removal that preserves favorites.
- Add local Favorites search and All/Radio/TV/Video/Audio filters.
- Reject incomplete/oversized port-change profile snapshots instead of silently
  dropping saved values; roll back partial restores and allow escaped JSON backups.
- Add an image-load watchdog so stalled artwork cannot hold a queue slot forever.
- Always schedule exit after an authenticated shutdown, even if the client
  disconnects during the response.
- Show zero counts explicitly instead of blank sidebar counts.

## 0.1.2

- Add five no-key sources: media.ccc.de/C3VOC, Library of Congress, gPodder
  podcasts, PeerTube/SepiaSearch, and Owncast, bringing the registry to eleven.
- Add an eleven-source concurrent catalog scheduler, per-provider rate limits,
  retry/cooldown handling, continuous cursor discovery, live-snapshot refresh, and
  truthful stale/rate-limited/complete status without false zero completion.
- Add authenticated semantic catalog routes for podcast feeds, PeerTube origin
  resolution, and Owncast rating-verified snapshots, plus a bounded persistent
  catalog cache and opaque artwork relay.
- Add an explicit/NSFW preference that is off by default, labels opted-in
  content, filters every mode, and preserves hidden favorites without weakening
  the network trust boundary.
- Add keyboard state, focus visibility, forced-colors support, and reduced-motion
  support while retaining a bounded 300-card DOM.
- Add seven immediate, persistent appearance choices and synchronize the
  native Windows title bar with the selected light, dark, or color theme.
- Add finite downloads, live MP3/MP4 recording, managed FFmpeg, automatic EQ,
  and global/favorite-specific presets to the persistent player bar.
- Add secure non-DRM DASH playback using bundled dash.js and an opaque,
  allow-listed SegmentTemplate relay; reject DRM and unsafe external MPD URLs.
- Make shutdown deterministic during startup and stale localhost sessions.
- Flush any EQ slider or preset-name edit still inside its debounce window
  before Shutdown or page hide so the automatic Global/favorite save cannot be
  lost during an immediate exit.
- Require every recording, download, FFmpeg-install, and job owner to confirm
  cleanup before shutdown is accepted.
- Pin the legacy metadata proxy to validated DNS addresses and enforce
  same-origin, query, redirect, and request-body limits.
- Add complete capture/storage guidance, Windows 10 22H2 provider requirements,
  reproducible build pins, and packaged third-party notices.
- Replace the antivirus-prone generated PyInstaller launcher with the official
  signed CPython 3.13.14 embedded runtime in a portable release folder/ZIP.
- Restore the owner-preferred classic `dist\WorldMediaWindows.exe` as a
  reproducible, current PyInstaller one-file build while retaining the signed
  portable folder/ZIP as an antivirus-friendly fallback.
- Keep transient source failures retryable instead of treating them as end-of-catalog.
- Give every provider a stable, cursor-based browse session with correct pagination.
- Continue automatic Internet Archive browsing across every curated collection;
  finishing a small collection such as the 81-item Classic Cartoons bucket no
  longer marks the entire Archive provider complete.
- Align proxy/client timeouts, recover failed IPTV preloads, and reduce disconnect log noise.
- Add visible Retry/Check Again controls, restore Library filters, and honor source settings live.
- Replace the rapidly wrapping per-source status pills with one fixed-height
  collection summary and compact, fixed-width Pull/Wait/Done/Live states in
  the source sidebar so catalog updates never move the gallery.
- Restore the original complete per-session Library pool so collection can grow
  past 40,000 items and finished-source counts never disappear.
- Recover transient fatal HLS media/network errors with bounded retries, cap
  IPTV adaptation to the video window, and preserve terminal Try Next behavior.
- Make legacy IPTV favorites immediately expose video recording instead of
  remaining on Checking, and keep FFmpeg capability checks single-flight.
- Select one quality-appropriate HLS rendition before recording instead of
  probing every master-playlist variant; retain cancellable bounded startup.
- Resume suspended Web Audio processing when delayed IPTV playback actually
  begins so EQ is not falsely reported unavailable after long buffering.
- Keep the EQ available when a live video has silent, delayed, or changing HLS
  audio segments; signal sampling is no longer treated as an engine failure.
- Detect HLS playback that stops advancing without a fatal error and perform a
  bounded reconnect, while cancelling recovery immediately when playback moves.
- Add a deeper live buffer and conservative bitrate headroom for irregular IPTV
  channels, and lower Windows recording-process priority to protect playback.
- Give every recording a readable local date/time suffix plus collision-safe
  numbering instead of adding a timestamp only after a name collision.
- Make Discovery query providers concurrently with a bounded deadline and strict filters.
- Add deterministic discovery regression tests and continuous integration.
- Fetch LibriVox cover art with catalog pages instead of per-card RSS requests.
- Queue, prioritize, retry, and clean up fallback thumbnail hydration; retry failed image loads.
- Remove large-session hot loops from Library filtering, IPTV paging, artwork
  registration, cache pruning, and HLS/DASH relay expiry; continuous pages now
  do work proportional to the new page rather than the whole collected catalog.
- Hydrate 24 visible thumbnails eagerly, prefetch 1,800 px ahead through 12
  bounded lanes, and release any artwork task that exceeds its 25-second
  watchdog so one failed host cannot clog thumbnail loading.
- Add a 60-second final catalog-task watchdog, a 128-request localhost backlog,
  higher bounded localhost/artwork throughput, batched disposable-cache writes,
  and change-only collection status rendering.
- Preserve the personalized portable data tree byte-for-byte while refreshing
  only its test EXE with the performance-unblocked build.

## 0.1.1

- Persist WebView2 storage so favorites, settings, and volume survive app restarts.
- Keep the Library background browse chain running while a search term is active.
- Prevent search pagination from exhausting the general browse stream.

## 0.1.0

- Created Windows-native World Media repo.
- Replaced Linux-in-a-box runtime with a local Python server and WebView2 shell.
- Added PyInstaller single-exe build path.
