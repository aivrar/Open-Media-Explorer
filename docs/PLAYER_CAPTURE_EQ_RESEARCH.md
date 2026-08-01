# Player Capture and Equalizer Research Dossier

Status: architecture approved for phased implementation
Research date: 2026-07-10
Target: World Media Windows 0.2.x
Companion execution plan: [PLAYER_CAPTURE_EQ_PHASES.md](PLAYER_CAPTURE_EQ_PHASES.md)

## Purpose

This document records the codebase audit, external research, decisions, risks,
interfaces, and acceptance requirements for four connected changes:

1. Correct the player bar's play/pause state and icon.
2. Add a context-sensitive Download or Record/Stop Recording action.
3. Add automatic, verified FFmpeg installation for capture work.
4. Add a real-time equalizer with global, favorite-specific, built-in, and
   user-defined presets that persist automatically.

This is a planning artifact. No production implementation is contained here.
The implementation must follow the phase gates in the companion plan.

## Executive conclusions

- The play/pause icon defect is a state-ownership bug, not an SVG problem.
  Both hidden media elements retain event listeners. A late `pause`, `ended`,
  `emptied`, or `error` event from the inactive element can overwrite the UI
  state of the active element. One `syncPlaybackUi()` function must be the only
  writer of player state and must ignore inactive-element events.
- Downloadability must be declared by adapters. File extensions and finite
  browser duration are useful fallbacks but are not reliable enough to be the
  primary classifier.
- Direct finite downloads should preserve the source bytes. Recording quality
  controls should apply to captured audio/video, not silently recompress an
  archive download.
- Live audio recordings will finish as MP3. Live video recordings will finish
  as H.264/AAC MP4. FFmpeg is therefore required for recording, probing, and
  finalization.
- FFmpeg must remain a separate executable invoked with `shell=False`; no
  FFmpeg libraries will be linked into the MIT application.
- A GPL FFmpeg build is required for dependable `libx264` and `libmp3lame`
  support. FFmpeg/GPL attribution, license preservation, source/build links,
  and a release-time compliance review are mandatory gates.
- Web Audio cannot process arbitrary cross-origin media directly. The Web
  Audio specification requires `MediaElementAudioSourceNode` to output silence
  for CORS-cross-origin media. Media that lacks usable CORS must therefore use
  an opaque, same-origin local media relay before it is connected to the EQ.
- The existing `/api/proxy` must not be reused as the media relay. It has a
  20-second timeout, a 50 MiB cap, API rate limiting, HTTPS-only policy, and a
  catalog-host allowlist. Those constraints are correct for metadata but wrong
  for continuous media.
- FFmpeg must consume only localhost relay URLs. Passing catalog-provided URLs
  directly to FFmpeg would bypass redirect/private-IP checks and create an SSRF
  and local-network access surface.
- All backend mutations must require exact same-origin validation plus a
  per-launch anti-CSRF token in a custom header. URLs, FFmpeg arguments, and
  output paths are never accepted as arbitrary command fragments.
- EQ changes apply to playback immediately. Persistence is debounced briefly
  to avoid synchronous localStorage writes on every pointer event, but there is
  no Apply or Save step for active EQ state.

## Current codebase audit

### Player and UI

- The global player is in `src/lib/player.js` and owns one hidden `<audio>` and
  one `<video>` element.
- `bindMediaEvents()` independently updates the global icon and `isPlaying`
  state from both elements. `clearMedia()` calls `pause()`, removes `src`, and
  calls `load()`, all of which can generate asynchronous events.
- `attachStream()` switches `currentEl` and then clears the other element.
  Events from that cleared element are not checked against `currentEl`.
- The existing button already contains play and pause SVGs. CSS has a global
  `[hidden] { display: none !important; }`, so markup and styling are capable of
  displaying the correct icon.
- The player bar is a four-column grid at desktop width and a three-row layout
  below 920 px. New actions need their own action cluster so progress and volume
  controls do not become compressed or reorder unpredictably.
- HLS uses the vendored hls.js build and Media Source Extensions when native HLS
  is unavailable. DASH uses the lazy, scoped dash.js lifecycle in
  `src/lib/dash-player.js`.

### Item model and source capabilities

The public item model currently has `type`, `stream_url`, and `stream_kind`, but
does not declare whether media is live, finite, downloadable, or needs special
request headers. Those capabilities must become explicit.

Required additions:

```text
delivery:        "live" | "on-demand" | "unknown"
download_url:    string or empty
download_name:   optional source-suggested filename
capture_headers: sanitized optional { referer, userAgent }
```

The fields must be normalized in `makeItem()` and documented in the item model.
Private adapter details may remain in `_extra`, but the player must not infer
core behavior from source IDs scattered throughout UI code.

Source mapping:

| Source | Delivery | Player URL | Download action |
|---|---|---|---|
| Radio Browser | Live | Station stream | Record audio |
| iptv-org | Live | HLS/DASH/direct TV stream | Record video |
| Internet Archive | On demand | Resolved derivative file | Download resolved file |
| NASA | On demand | Resolved media asset | Download resolved file |
| Wikimedia Commons | On demand | Direct media file | Download direct file |
| LibriVox | On demand | First chapter for current playback | Download the official full-audiobook ZIP when available; otherwise current resolved audio |

Adapter resolution must populate `download_url` at the same time it populates a
lazy `stream_url`. Download/Record remains disabled with a visible reason until
resolution finishes.

### Live source snapshot

The following measurements were taken on 2026-07-10 and are evidence for the
design, not hard-coded assumptions:

- iptv-org exposed 17,263 streams: 16,623 HLS, 244 DASH, 294 other HTTP,
  95 other HTTPS, and 7 other forms.
- 303 IPTV entries required a referrer and 832 supplied a custom user agent.
  Capture and relayed playback must preserve these values.
- A sample of the top 200 Radio Browser stations contained 110 HTTPS and 90 HTTP
  URLs. Codecs were predominantly MP3, AAC, and AAC+. Twenty-three were marked
  or named as HLS. A media relay that accepts only HTTPS would break legitimate
  radio playback.

### State and persistence

- Favorites are stored as JSON in `worldmedia.favorites.v1` in WebView2
  localStorage.
- Settings are stored in `worldmedia.settings.v1`; volume has a separate key.
- pywebview points WebView2 at
  `%LOCALAPPDATA%\WorldMediaWindows\webview2_data`, so localStorage persists in
  that user-data folder.
- EQ data should not be embedded into favorite item objects. Use a versioned,
  separate key so migrations and cleanup are deterministic:

```json
{
  "version": 1,
  "global": { "preamp": 0, "bands": [0,0,0,0,0,0,0,0,0,0], "presetId": "flat" },
  "favorites": { "source:item-id": { "preamp": 0, "bands": [], "presetId": "custom" } },
  "customPresets": { "uuid": { "name": "My preset", "preamp": 0, "bands": [] } }
}
```

- Favoriting the current item copies its current effective EQ into a new
  favorite-specific record so the sound does not jump.
- Unfavoriting removes that favorite-specific record and immediately restores
  the global EQ. This prevents orphaned per-item data.
- Slider changes update the audio graph immediately and persist to the active
  target after a 150 ms debounce. Closing the overlay does not control saving.
- Built-in presets are immutable templates. A named custom preset is created
  with a name action; when that custom preset is selected, later edits update
  it automatically. Favorite/global state stores a curve snapshot rather than
  a live reference, so editing a preset does not unexpectedly alter other
  favorites.
- `clearCache()` must include EQ state and job history but must not delete
  completed downloads or the managed FFmpeg installation.

### Native runtime and filesystem

- In a PyInstaller one-file build, `_MEIPASS` is a temporary extraction folder.
  It must never be used as the downloads or tools directory.
- In a frozen build, the portable root is `Path(sys.executable).resolve().parent`.
  In source mode it is the repository root.
- Default completed output is exactly `<portable root>\downloads`, matching the
  requested portable behavior.
- Default managed tool location is `<portable root>\tools\ffmpeg`.
- Both paths require an atomic write probe. If the portable root is read-only,
  the app must explain the problem and offer an explicit LocalAppData fallback;
  it must not silently put user media elsewhere.
- Filenames must remove control characters and Windows-invalid characters,
  trim trailing dots/spaces, avoid reserved device names, limit the stem, and
  use a timestamp/counter collision suffix. The backend—not the browser—creates
  the final path.
- Temporary output uses a unique `.part` or `.recording` name in the target
  directory so the final `os.replace()` remains atomic on one volume.

### Existing server limitations

`worldmedia_server.py` is currently one module containing static hosting,
metadata proxying, rate limiting, and shutdown. Capture work must be split into
testable modules rather than growing the handler into a process manager.

Proposed Python modules:

```text
worldmedia_security.py     origin/token/body/URL/path validation
worldmedia_media.py        safe upstream connector and opaque relay registry
worldmedia_ffmpeg.py       discovery, capability probe, verified installer
worldmedia_jobs.py         thread-safe download/record job state machine
worldmedia_capture.py      command construction and capture/finalization
```

The HTTP handler should only parse requests, call these services, and serialize
responses.

## External research findings

### Playback events

`HTMLMediaElement.paused` is the authoritative playback state. `play`,
`playing`, `pause`, `ended`, `emptied`, and `error` are lifecycle signals, but
only events from the active element may update the global UI.

Sources:

- [MDN: HTMLMediaElement.paused](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/paused)
- [MDN: HTMLMediaElement events and duration](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement)

### Web Audio and cross-origin media

The Web Audio specification explicitly requires a
`MediaElementAudioSourceNode` to output silence for a CORS-cross-origin media
resource. This is why the EQ needs same-origin playback URLs rather than a
simple `createMediaElementSource()` call over the existing direct streams.

The EQ graph will use Web Audio nodes:

```text
active media source
  -> preamp GainNode
  -> 10 BiquadFilterNode bands
  -> DynamicsCompressorNode safety limiter
  -> AudioContext.destination
```

Bands use 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, and 16000 Hz.
The first and last bands are low/high shelves; the interior bands are peaking
filters. Gains are limited to -12 dB through +12 dB. Preamp is limited to
-12 dB through +6 dB. `AudioParam.setTargetAtTime()` provides short smoothing
to avoid zipper noise.

A source node is created once per media element and reused. AudioContext is
created/resumed from a user gesture to satisfy autoplay policies.

Sources:

- [W3C Web Audio API: MediaElementAudioSourceNode security](https://www.w3.org/TR/webaudio-1.0/)
- [W3C Web Audio API 1.1: BiquadFilterNode](https://www.w3.org/TR/webaudio-1.1/)
- [W3C Media Source Extensions: MediaSource origin](https://www.w3.org/TR/media-source-2/)
- [MDN: AudioContext.resume()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)

### HLS and live classification

HLS `#EXT-X-ENDLIST` states that no more segments will be added. A VOD playlist
uses `#EXT-X-PLAYLIST-TYPE:VOD` and an end marker. Absence of an end marker is
not, by itself, enough to override an adapter's known delivery type; IPTV is
declared live by its adapter.

Source:

- [RFC 8216: HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216)

### FFmpeg capture, progress, and output

- `-progress pipe:1` emits machine-readable key/value groups ending in
  `progress=continue` or `progress=end`.
- Stream copy avoids generational loss but cannot guarantee MP4 compatibility.
- Transcoding is required for resizing, EQ/filtering, or codec compatibility.
- FFmpeg HTTP input supports user-agent/referrer headers and bounded reconnect
  controls.
- Normal MP4 can be unusable if interrupted before its metadata is finalized.
  Fragmented MP4 remains decodable after interruption, with a compatibility
  tradeoff. Recording should therefore write a fragmented working MP4 and remux
  it into a normal `+faststart` final MP4 after a graceful stop.

Sources:

- [FFmpeg main documentation](https://ffmpeg.org/ffmpeg.html)
- [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html)
- [FFmpeg format/muxer documentation](https://ffmpeg.org/ffmpeg-formats.html)
- [ffprobe documentation](https://ffmpeg.org/ffprobe.html)
- [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html)

### FFmpeg acquisition and licensing

FFmpeg publishes source code and links to BtbN and gyan.dev for Windows
executables. BtbN publishes static x64 builds, SHA-256 checksums/digests, GPL and
LGPL variants, stable release-branch assets, and a floating `latest` release.

Selected managed asset family:

```text
Repository: BtbN/FFmpeg-Builds
Release API: https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest
Asset: ffmpeg-n8.1-latest-win64-gpl-8.1.zip
Required programs: ffmpeg.exe and ffprobe.exe
```

The asset is deliberately selected by exact allowlisted filename, size range,
content type, repository identity, and `sha256:` digest from GitHub's release
asset metadata. The downloaded bytes are hashed before extraction. ZIP member
paths and expanded size are validated before extraction. Installation is staged
and atomically renamed.

Snapshot on 2026-07-10 (informational only because `latest` floats):

```text
Latest release name: Latest Auto-Build (2026-07-10 13:44)
Asset size: 167,400,020 bytes
Asset digest: sha256:9a9bf189584948296b6ce34a9cd843b58f6d7d9ee42f7139aec448651a55506c
```

The installer must not trust the snapshot above after the release changes; it
must verify the digest returned for the exact asset it downloads and record the
release ID, asset ID, digest, version output, and install time locally.

The GPL build is chosen because BtbN documents that the LGPL build omits GPL
dependencies, prominently libx264/libx265. The application invokes FFmpeg as a
separate command-line process with simple arguments/pipes; it does not link or
load FFmpeg code. Nevertheless, this plan is not legal advice. The About view,
installer confirmation, installed tool folder, release notes, and distribution
documentation must clearly identify FFmpeg and its license. If an app release
ever bundles the FFmpeg archive or binary, corresponding-source obligations
must be satisfied before release.

Sources:

- [FFmpeg official download page](https://ffmpeg.org/download.html)
- [FFmpeg legal and licensing guidance](https://ffmpeg.org/legal.html)
- [BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- [GitHub release asset API and SHA-256 digest field](https://docs.github.com/en/rest/releases/assets)
- [GNU GPL FAQ: separate programs, command lines, and pipes](https://www.gnu.org/licenses/gpl-faq.en.html)
- [GNU GPL v3 aggregate definition](https://www.gnu.org/licenses/gpl-3.0.html)

### Safe process and archive handling

- FFmpeg and ffprobe are started with an argument list and `shell=False`.
- No title, URL, header, filename, preset, or user text becomes an executable
  option name or shell fragment.
- stdout and stderr are drained concurrently to avoid pipe deadlocks.
- FFmpeg progress uses stdout; diagnostic stderr is retained in a bounded ring
  buffer with credentials and relay tokens redacted.
- Graceful stop writes `q` to FFmpeg stdin and waits. Timeout fallback is
  terminate, then kill. The output is validated with ffprobe before publication.
- ZIP members are inspected for absolute paths, drive/UNC paths, `..`, links,
  file-count limits, and expanded-size limits before extraction.

Sources:

- [Python subprocess security and process control](https://docs.python.org/3/library/subprocess.html)
- [Python zipfile security notes](https://docs.python.org/3/library/zipfile.html)
- [Python hashlib SHA-256/file_digest](https://docs.python.org/3/library/hashlib.html)
- [PyInstaller runtime path information](https://pyinstaller.org/en/stable/runtime-information.html)

### Localhost API and SSRF security

Control endpoints that write files or spawn processes are security-sensitive.
Every mutation requires:

- Host exactly `127.0.0.1:<active port>` or `localhost:<active port>`.
- Origin exactly the current local origin.
- JSON content type, bounded body, and a custom `X-WorldMedia-Token` header.
- A cryptographically random per-launch token obtained from a same-origin GET.
- No permissive CORS headers and no successful cross-origin preflight.

Custom headers trigger browser preflight for cross-origin requests. The server
must not authorize those preflights. Origin/token validation is still required;
CORS alone is not authentication.

The media connector accepts only HTTP/HTTPS, rejects credentials in URLs,
resolves to globally routable addresses, connects to a validated address, and
repeats validation on every redirect. Loopback, private, link-local, multicast,
reserved, unspecified, metadata, and non-global address space are rejected.
Opaque relay tokens prevent the browser and FFmpeg from submitting arbitrary
URLs to GET endpoints.

Sources:

- [MDN CORS and preflight behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
- [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP SSRF guidance](https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/)
- [Python ipaddress global/private semantics](https://docs.python.org/3/library/ipaddress.html)

## Approved architecture

### Frontend modules

```text
src/lib/player.js              orchestration only; no large new subsystems
src/lib/player-state.js        active media state and UI synchronization
src/lib/media-capabilities.js  adapter capability normalization and labels
src/lib/capture-client.js      authenticated API client and job polling
src/lib/audio-engine.js        one AudioContext and reusable EQ graph
src/lib/eq-store.js            validation, migration, auto-persistence, presets
src/lib/eq-overlay.js          accessible overlay and frequency response UI
```

`player.js` remains the public facade (`playItem`, `togglePlay`, `stop`, volume,
and current item), but delegates state, capture, and EQ work.

### Playback routing

1. Resolve the adapter item.
2. Register the resolved upstream URL and sanitized headers with the backend.
3. Receive an opaque short-lived local playback URL.
4. Direct audio/video uses the byte/range relay.
5. HLS uses hls.js. If upstream CORS works, existing MSE playback may be used;
   otherwise the local HLS relay rewrites manifest URI lines and `URI=`
   attributes (segments, alternate media, maps, and keys) to child opaque URLs.
6. Media element source nodes feed the Web Audio graph.
7. If relay or Web Audio initialization fails, playback must fail visibly or
   fall back to unprocessed playback with EQ explicitly marked unavailable. It
   must never silently play muted audio.

The relay is streaming and backpressure-aware. It supports GET/HEAD, Range,
Content-Range, Content-Length where known, content type, and continuous bodies.
It has separate concurrency/time policies from the metadata proxy.

### Download and recording classification

Primary classification is `item.delivery` plus `download_url`.

Fallback rules, in order:

1. Adapter-declared live always records.
2. Adapter-declared on-demand with a download URL always downloads.
3. HLS VOD/ENDLIST or static DASH may download only after manifest inspection.
4. A finite direct media URL with a usable filename/content length downloads.
5. Indefinite duration, live manifest, or unknown station/TV source records.
6. Unresolved ambiguity disables the action and displays `Checking media…` or
   an actionable reason; it never guesses destructively.

DRM-protected or unsupported encrypted media is not captured. The app does not
attempt to obtain keys, bypass access controls, or defeat DRM.

### Job model

Job states are explicit and monotonic:

```text
queued -> preparing -> downloading|recording -> stopping|finalizing -> completed
                                                       \-> failed
queued|preparing|downloading -> cancelled
recording -> failed (with recoverable working file when possible)
```

Each job has a random ID, item ID/title/source, job kind, timestamps, elapsed
time, bytes, optional expected bytes/duration, output path only after backend
validation, progress, safe status text, return code, and bounded redacted error.

Limits:

- One active live recording.
- Up to two finite downloads.
- Duplicate active jobs for the same item/action are rejected idempotently.
- Jobs run independently of playback pause. Switching items does not silently
  stop an active recording.
- If another item is selected during a recording, its action shows that another
  recording is active and offers navigation/status rather than starting a
  second recorder.
- App shutdown detects active jobs, requests graceful stop/finalization, waits
  for a bounded interval, and only then exits. Completed downloads are never
  removed by cache clearing.

### Recording profiles

The Settings label is `Recording quality`; direct downloads always preserve
their original bytes.

| Profile | Audio output | Video output |
|---|---|---|
| Compact | MP3 96 kb/s | H.264 up to 480p, CRF 27, AAC 96 kb/s |
| Balanced (default) | MP3 160 kb/s | H.264 up to 720p, CRF 23, AAC 160 kb/s |
| High | MP3 256 kb/s | H.264 up to 1080p, CRF 20, AAC 192 kb/s |

Video encoding uses `libx264` with a performance-oriented preset selected after
benchmarking on the Windows CI/manual test machine. Scaling only reduces media;
it never upscales a lower-resolution source. Pixel dimensions remain even.

Working video output is fragmented MP4 for interruption resilience. Graceful
Stop Recording closes the process, validates the working file, and remuxes it
to a normal fast-start MP4 before atomic publication. Audio records directly to
a temporary MP3 and is validated before publication.

The live playback EQ is not baked into downloaded or recorded files. Capture
quality and playback EQ are intentionally independent; the UI must say so.

### FFmpeg lifecycle

Discovery order:

1. Explicit `WORLDMEDIA_FFMPEG_PATH` test/developer override.
2. App-managed portable tool directory.
3. System PATH.
4. App-managed LocalAppData fallback.

Both ffmpeg and ffprobe must exist and pass a capability probe for the required
demuxers/muxers/encoders. Merely finding `ffmpeg.exe` is insufficient.

First recording action when no capable tool is installed opens a one-time,
non-administrative installation confirmation showing provider, version family,
approximate size, license, destination, and links. On confirmation the action
continues automatically after installation. Settings also exposes Install,
Repair, Remove managed copy, version, path, and status.

Installer sequence:

1. Fetch GitHub latest release JSON with an explicit user agent and timeout.
2. Select only the exact approved stable-branch x64 GPL ZIP name.
3. Validate repository, release, asset state, size range, URL host, and digest.
4. Download to a unique `.part` file with progress, cancellation, and size cap.
5. Verify SHA-256 against the API asset digest.
6. Inspect and CRC-test ZIP; validate paths and expanded size.
7. Extract only into a staging directory while retaining license/readme files.
8. Probe ffmpeg/ffprobe version and required capabilities.
9. Atomically replace the managed version directory and manifest.
10. Delete failed staging files; never replace a working installation with a
    failed update.

### Backend control API

Tentative versioned routes; exact response schemas are frozen in Phase 3 tests:

```text
GET  /api/v1/session
GET  /api/v1/runtime
GET  /api/v1/ffmpeg/status
POST /api/v1/ffmpeg/install
POST /api/v1/ffmpeg/cancel-install
POST /api/v1/media/register
GET  /api/v1/media/<opaque-token>
POST /api/v1/jobs/download
POST /api/v1/jobs/record
POST /api/v1/jobs/<id>/stop
POST /api/v1/jobs/<id>/cancel
GET  /api/v1/jobs
GET  /api/v1/jobs/<id>
POST /api/v1/downloads/open-folder
```

All JSON uses a versioned envelope with `ok`, `data`, and structured `error`
(`code`, safe `message`, optional retryability). UI never parses FFmpeg stderr
to decide job state.

Polling at 500-1000 ms is sufficient for one local user and simpler than adding
WebSocket lifecycle/security. Server-Sent Events may be considered only after
polling performance is measured.

### Player bar behavior

- Playing: pause icon and `aria-label="Pause"`.
- Paused, ended, stopped, or failed: play icon and `aria-label="Play"` when a
  resumable source remains.
- Finite item: Download button.
- Live item idle: Record button.
- Selected item is actively recording: Stop Recording button with red active
  treatment and elapsed time.
- A download in progress: progress treatment and Cancel action in its menu.
- EQ button always reflects bypass/active state and opens one overlay.
- Status is exposed through an ARIA live region without replacing source/title
  text.
- Narrow layouts keep play/stop/action/EQ reachable; lower-priority labels may
  collapse to icons with tooltips, but actions never disappear.

### Equalizer UI and behavior

- Ten vertical band sliders, preamp, bypass, reset-to-flat, built-in preset
  selector, custom preset create/rename/delete, and response curve.
- Built-ins: Flat, Bass Boost, Treble Boost, Vocal, Spoken Word, Rock, Classical,
  Jazz, Electronic, and Night.
- Every slider has a visible frequency label, current dB value, keyboard support,
  and an accessible name.
- The overlay shows the active persistence scope: `Global` or the favorite item
  title. This removes ambiguity about what is being updated.
- Selecting an item loads its effective scope before playback begins, then uses
  smoothed parameter changes.
- Favorite changes while playing update scope immediately according to the
  rules in the persistence section.
- Bypass retains settings but connects an audibly flat path. Reset writes a flat
  curve to the current target immediately.

## Security and privacy invariants

- Localhost binding remains mandatory.
- No telemetry, accounts, or cloud state is added.
- No shell invocation or arbitrary FFmpeg option API exists.
- No arbitrary output path from the web UI is trusted.
- No private/local/metadata IP may be reached through registration, redirects,
  HLS child URLs, downloads, probes, or capture.
- Relay/capture tokens are random, scoped, short-lived, redacted from logs, and
  invalidated when items/jobs end.
- Request headers are allowlisted and CR/LF stripped. Authorization and Cookie
  are not accepted from catalog item data.
- Logs redact URLs containing credentials/query tokens and never log anti-CSRF
  or relay tokens.
- The app records only after an explicit user click and shows an unmistakable
  recording state.
- Source content rights remain with providers. UI and documentation remind the
  user to download/record only where permitted. No DRM bypass is implemented.

## Rejected shortcuts

- **Use MediaRecorder on the media element:** inconsistent codec/container
  availability, CORS restrictions, poor HLS behavior, and no reliable MP4 output.
- **Connect every existing media element directly to Web Audio:** produces
  silence for non-CORS sources by specification.
- **Pass remote URLs directly to FFmpeg:** loses redirect/private-IP control and
  makes header/security behavior source-dependent.
- **Reuse `/api/proxy`:** its metadata limits intentionally terminate large or
  long-running bodies.
- **Bundle FFmpeg inside the one-file EXE immediately:** increases release size,
  complicates replacement and license/source obligations, and makes security
  updates dependent on full app releases.
- **Trust an FFmpeg executable because it exists:** old/minimal builds may lack
  ffprobe, libx264, libmp3lame, protocols, or muxers.
- **Infer live status only from URL suffix:** playlists, redirects, PHP endpoints,
  and extensionless streams make this unreliable.
- **Store EQ inside favorite item JSON:** tangles media metadata with versioned
  user audio state and makes migrations/removal ambiguous.
- **Write downloads into `_MEIPASS`:** it is temporary in one-file builds.

## Known boundaries

- DRM capture is out of scope and intentionally rejected.
- DASH playback improvement is out of scope; DASH recording can still be handled
  by FFmpeg for adapter-declared live IPTV when the manifest is not DRM-protected.
- Playback EQ is not rendered into saved files.
- Only the x64 Windows build is approved initially. ARM64 requires a separately
  tested asset/capability matrix and PyInstaller build.
- The BtbN build currently targets modern Windows; the release requirements must
  state Windows 10 22H2 or newer unless compatibility testing proves otherwise.

## Research-to-implementation traceability

Every substantive decision above appears as a task and exit gate in
[PLAYER_CAPTURE_EQ_PHASES.md](PLAYER_CAPTURE_EQ_PHASES.md). If implementation
discovers a contradictory fact, execution stops, this dossier is amended with
the evidence, and the affected phase is replanned before code continues.
