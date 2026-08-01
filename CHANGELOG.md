# Changelog

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
