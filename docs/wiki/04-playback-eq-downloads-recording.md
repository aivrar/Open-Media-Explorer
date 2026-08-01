# Playback, EQ, downloads, and recording

## Playback lifecycle

Clicking a card or detail-panel **Play** selects the single global player. The
player:

1. Resolves fresh metadata when a favorite contains an expired relay token.
2. Refreshes bounded stream candidates when an adapter supports alternates.
3. Registers the selected upstream through an opaque localhost media relay.
4. Probes up to two candidates at once (maximum eight candidates per item) and
   keeps the first working candidate.
5. Attaches audio, direct video, HLS, or DASH to the native WebView media
   element.
6. Applies the effective global/favorite EQ curve and starts playback.

Upstream URLs and required headers are never placed in the browser's control
API. Local relay IDs are short-lived and are removed from persisted favorites.

### Player controls

- **Play/Pause** toggles the current media. If a stream entered a failed state,
  Play rebuilds the relay and HLS/DASH session instead of calling `play()` on a
  poisoned element.
- **Stop** releases the relay, destroys HLS/DASH state, clears media elements,
  hides the player bar, and returns catalog/artwork priority to normal.
- **Try next** appears for a broken live item when alternate candidates or a
  source-level retry is appropriate.
- **Seek** is enabled for finite media with a known duration. Live streams
  normally have no seek range.
- **Mute** and **volume** affect playback only. Volume is persisted locally.
- The player star changes the same favorite record as a card star.
- The small video overlay sits above the bottom player and supports the browser
  media element's full-screen controls.

### HLS and DASH behavior

HLS uses the vendored hls.js build when WebView2 does not provide native HLS;
DASH uses dash.js and Media Source Extensions. The local relay rewrites child
manifest/segment references so the browser never needs direct cross-origin
access. DRM-protected DASH manifests are rejected.

For HLS, the player starts with automatic throughput selection under a 720p
ceiling when that rendition exists. Repeated stalls can lower the ceiling for
the current viewing session. The recovery controller retries recoverable fatal
errors, waits for startup buffer, and reports a terminal error when the origin
cannot provide a usable playlist/segment. This improves rough channels but
cannot fix an overloaded broadcaster or poor network path.

### Playback priority and thumbnails

When media emits `play`/`playing`, the catalog scheduler enters playback
priority: at most two catalog tasks and one low-priority background task are
allowed, and artwork queues reduce to one metadata resolver/two image workers.
The work is throttled, not cancelled. Stop or pause releases that priority.
This prevents a fast catalog fan-out from competing with a live stream.

## Equalizer

Open EQ from the player bar. The overlay states “Changes apply immediately and
save automatically”; there is no Apply button.

### Scopes

- **Global** is the default curve for non-favorite items.
- **Favorite scope** is created with **Add favorite** in the EQ overlay or by
  favoriting the current item. That item then keeps its own curve when it is
  played later.
- Removing the favorite removes the favorite EQ association and returns the
  item to the global curve.

The curve contains preamp plus ten bands: 31, 62, 125, 250, 500, 1k, 2k, 4k,
8k, and 16k Hz. Band gains are clamped to ±12 dB; preamp is clamped to −12 to
+6 dB. **Bypass** leaves the curve stored but removes it from audible output.

### Presets

Built-in presets are Flat, Bass Boost, Treble Boost, Vocal, Spoken Word, Rock,
Classical, Jazz, Electronic, and Night. **New preset** creates a named custom
preset; custom presets can be renamed or deleted. **Reset to flat** sets the
current scope to a neutral curve.

Web Audio applies smoothing to live playback. A boosted curve uses a limiter to
avoid clipping. If the same-origin relay or Web Audio signal cannot be made
safe, the app reports EQ unavailability rather than silently playing a muted
audio stream.

## Downloads

Download is available only for finite on-demand originals/derivatives. A live
HLS/DASH playlist is not treated as a finite download.

1. Select an item with a Download capability.
2. Press **Download** in the detail/player capture control.
3. The app creates a job, validates content type and size, and writes a hidden
   `.part` file in `downloads`.
4. If the provider supports byte ranges and a stable validator, an interrupted
   transfer can resume safely. If the source changed, the partial is restarted.
5. The file is atomically renamed only after the declared/validated media is
   complete. Failed/cancelled partials are removed when possible.

The capture control shows preparing, progress, finalizing, completed, failed,
or cancelled states. **Cancel download** is safe; completed jobs can open the
folder or be started again. The backend enforces a small concurrent-download
limit and de-duplicates equivalent active jobs.

Files are sanitized and kept under the approved `downloads` root. Oversized,
HTML/error, empty, truncated, or audio/video-mismatched responses are rejected.

## Live recording

Recording is a separate upstream connection. Pausing playback, muting, changing
volume, changing the playback EQ, or stopping the player does not pause a
recording that is already running. The recording captures the stream through
FFmpeg and writes its own file.

### Requirements and workflow

1. Leave **Recorder** enabled in Settings.
2. Install or select a capable `ffmpeg`/`ffprobe` pair in Settings.
3. Start a live radio/TV item and press **Record audio** or **Record video**.
4. Choose the quality profile in Settings before starting the next recording.
5. Press **Stop recording**. FFmpeg is asked to flush and finalize; only after
   validation is the finished file published.

The app chooses audio/video recording kind from the item or a bounded FFprobe
inspection. Video recordings require H.264/AAC-compatible output; audio uses
MP3. Output names are sanitized and collision-safe.

### Quality profiles

| Profile | Audio bitrate | Video ceiling | Video quality |
|---|---:|---:|---|
| Compact | 96 kbps | 480p | CRF 27 |
| Balanced (default) | 160 kbps | 720p | CRF 23 |
| High | 256 kbps audio (192 kbps in video) | 1080p | CRF 20 |

The profile is a ceiling/encoding choice; the source is never upscaled.
FFmpeg runs below normal priority on Windows so interactive playback remains
responsive.

### EQ in recordings

The exact normalized EQ curve active when **Record** is pressed is passed to
FFmpeg and baked into the saved audio. Later changes to the player EQ, volume,
mute, or favorite scope do not rewrite an existing file. Bypass at recording
start produces an un-EQ'd recording.

### Turning Recorder off

Settings → Capture & storage → **Recorder** off prevents new recordings. If a
recording is running or FFmpeg is installing for one, the UI requests a stop or
cancel once; the recording is finalized/cancelled through the normal job state
machine. Downloads remain enabled. Re-enable the switch before starting a new
recording.

## FFmpeg management

World Media does not bundle FFmpeg in the EXE. Settings can:

- detect an existing capable pair;
- install the managed GPL build after an explicit confirmation;
- choose **Portable** (beside the app) or **LocalAppData** (per-user fallback);
- cancel an installation;
- repair a failed/corrupt managed copy; or
- remove only the selected managed copy.

The managed archive is downloaded without administrator access, verified against
the published SHA-256 digest, staged, capability-probed, and activated
atomically. Its license/source records remain beside the binaries. See About
and [the build guide](../BUILD_WINDOWS.md) for legal and packaging details.
