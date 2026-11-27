# Playback, EQ, downloads, and recording

## Playback lifecycle

Clicking a card or detail-panel **Play** selects the single global player. The
player:

1. Resolves fresh metadata when a favorite contains an expired relay token.
2. Refreshes bounded stream candidates when an adapter supports alternates.
3. Registers the selected upstream through an opaque localhost media relay.
4. Probes the candidates (at most eight per item) and keeps the first working
   one. How it starts depends on **Settings > Content > Pick the best stream**
   (see below): with **Listed streams**, the default, the best listed stream
   gets a head start of six seconds; with **Off**, the first two are tried
   together.
5. Attaches audio, direct video, HLS, or DASH to the native WebView media
   element.
6. Applies the effective global/favorite EQ curve and starts playback.

Upstream URLs and required headers are never placed in the browser's control
API. Local relay IDs are short-lived and are removed from persisted favorites.

### Player controls

- **Play/Pause** toggles the current media. If a stream entered a failed state,
  Play rebuilds the relay and HLS/DASH session instead of calling `play()` on a
  poisoned element. Since v0.1.12 it also connects again after a stream ended
  by itself, instead of trying to play the stream that had ended.
- **Stop** releases the relay, destroys HLS/DASH state, clears media elements,
  hides the player bar, and returns catalog/artwork priority to normal.
- **Try next** appears for a broken live item when alternate candidates or a
  source-level retry is appropriate.
- **Seek** is enabled for finite media with a known duration. A live stream
  (internet radio, live TV) has no length to move along, so the seek bar and
  the length beside it are not shown while it plays, and the time label shows
  how long it has played. A station or channel listed as live is treated as
  live from the start, unless the player finds a complete recording behind it;
  an item listed as on demand (a film, a podcast episode) always keeps its
  seek bar. Anything else counts as live when the player says so, when it has
  no end, or when its length keeps growing with the clock.
- **Mute** and **volume** affect playback only. Volume is persisted locally.
  The speaker button shows a crossed-out speaker when the sound is muted or the
  volume is at zero. Beside it, the volume control has an up button, the volume
  as a number from 0 to 100, and a down button. Point at it to see the volume as
  a percentage: it starts at 80%, and 100% is full volume (there is no boost).
  A click changes the volume by 1; holding a button repeats after a 0.4 second
  pause (about 14 steps in the first second); the mouse wheel over the control
  changes it by 2 per notch; with the control focused, the arrow keys change it by 1, Page Up and
  Page Down by 10, and Home and End set 0 and 100. When the bar uses two rows,
  the control reads down, number, up. Changing the
  volume or mute with a video's own controls moves the number and the speaker
  icon too, and that volume is the one that is saved.
- The player star changes the same favorite record as a card star.
- The floating video keeps its play and pause, volume, fullscreen and menu
  controls for live TV. It hides the video timeline and time numbers, which
  showed only the station's short live window. On-demand video keeps the
  timeline, and a stream that turns out to be finite gets it back. The controls
  use a shade that fades from 45% black to clear over 48 px in the player and
  64 px in fullscreen. The icons have shadows for bright pictures.
- **Picture** next to **EQ** adjusts the displayed video. **Fit** can show the
  whole picture, fill the box or zoom in to crop black bars. Fit applies in
  fullscreen. See [Window layout](02-using-the-application.md#window-layout).

### Picture quality

When a video or TV stream offers at least two levels, **Quality** appears
under **Fit** in the **Picture** panel.

- **Auto** is the default. It chooses a level for the size of the picture
  and the connection. It checks again when you enlarge the picture or go
  fullscreen. When it steps up, it replaces buffered lower-quality video
  so the change shows sooner.
- **Best available** lets the player choose without a limit based on picture
  size. It can use more data and processor time.
- A fixed level shows the resolution and bitrate, for example
  **1080p · 5.86 Mbps**. When the stream gives no resolution, the option
  shows the bitrate. If a fixed level fails, the panel says "Fixed quality
  failed. Using Auto for this session."

The note beside the menu shows the resolution playing now, for example
**Now 720p**. Save the choice under **For this channel** or **For all video**.
See [Window layout](02-using-the-application.md#window-layout) for how the
picture settings are saved.

![Picture panel - Fit and Quality controls for a video](<../../screenshots/v0.1.14/picture-panel.png>)

### Tracks and chapters

Internet Archive audio with several tracks and LibriVox books play in order.
The next part starts by itself. The player bar shows **Track N of M** or
**Chapter N of M**, with **Previous part** and **Next part**. You can also pick
a track or chapter in the item's details. When a position is saved, reopening
the item offers a resume button in the player bar with the part and time,
such as **Resume chapter 2 at 3:10**. **Start over** plays from the beginning.

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

### Reconnecting a live stream

When a live radio or TV stream that was playing loses its connection, World
Media tries again by itself instead of stopping. The player bar says
"Connection lost. Retrying...". The pauses between attempts grow (2, 4, 8 and 16
seconds, then 30 seconds each) and the retrying lasts up to ten minutes. Each
attempt rebuilds the stream exactly as **Play** does. Once the stream has
played for about 30 seconds in total, the retrying is over. If nothing works
in ten minutes, the bar says "Can't reconnect. Press Play." **Try next** stays
available while it retries.

- **Pause** ends the retrying, and the bar says "Connection lost. Press Play."
  **Stop** and the sleep timer end it too.
- **Play** tries again at once. So does Windows reporting that the network is
  back.
- A station that never started playing is not retried. It shows the usual
  error and **Try next**.

A live stream that is played directly (not as HLS or DASH) can also freeze
without any error. If the sound or picture stands still for about 20 seconds
while it should be playing, World Media treats that as a lost connection and
reconnects in the same way.

Since v0.1.12 the same is true when the station closes the connection of such
a stream. Before, the player took that for the end of the stream and stopped,
showing **Play**. Now it says "Connection lost. Retrying..." and reconnects to
the same station. A file with a known length that plays to its end is not
started again.

### Song title

Many internet radio stations announce the song they are playing. When a
station does, the player bar shows the title under the station name, with a
note sign, in place of the usual line (source, country and language, which stay
readable when you point at it). The Windows media overlay shows the song as the
title and the station as the artist. The title changes by itself when the next
song starts, and it goes away when playback stops or the station is changed.

- It works for radio and audio streams that are played directly (Shoutcast
  and Icecast style streams, which carry the title inside the audio).
  Stations that are delivered as HLS do not show one.
- Not every station sends titles. Some send a jingle name, an advertisement or
  filler text instead of a song. World Media shows what the station sends.
- A recording or a download never asks the station for titles, so the saved
  file is the same as before. A station whose server breaks when it is asked
  for titles is played without them, and is not asked again for an hour.
- The title is plain text. A station cannot make World Media open a link or
  show formatted text.

Every new title is added to the **Song log** (the musical note in the top bar).
See [Using the application](02-using-the-application.md) for the log and
[Show what's playing](02-using-the-application.md#show-whats-playing)
in Favorites.

### Stream format and other streams

A station's stream format and bitrate show as one short label, for example
"MP3 · 128 kbps": in the detail panel, in the tooltip of its card in the
Library and the Tuner ("Stream: MP3 · 128 kbps"), on the Library card when
**Show technical source details** is on (the Tuner card then reads, in a short
form, "MP3 128k · Radio Browser"), and when you point at the source line in the
player bar.

Radio Browser stations list the format and bitrate of their stream, and that is
what is shown for them: what the directory says, not a measurement. Since
v0.1.16 the app also remembers what a station's own stream said the last time it
played: the audio type of its reply (MP3, AAC, AAC+, Ogg, Opus, FLAC or WAV) and,
when the station sends one, its bitrate. It is remembered for each station once
the station has played for a second, and it fills in only what the directory
leaves out; so a station from your own playlists, or from any other source,
shows its label after it has played once. Nothing is probed or asked for to get
it. The values are a cache in the browser storage (at most 1,000 stations, the
oldest go first). **Clear local cache** removes them. Backups leave out
this cache.

HLS streams now get a stream line too. Video details can include resolution,
frame rate, video codec and bitrate. World Media remembers them per item after
five stable seconds of playback. For example, "Stream: HLS · 1080p · 50 fps ·
H.264 · 6.22 Mbps". Bitrates use up to three significant digits. The line
appears in the item's details, its tooltip and the Now Playing **Format** row.
On a Library card it gets up to two lines when **Show technical source
details** is on. The line shows the fields available from the stream.

The detail panel of a Radio Browser station also has an **Other streams**
button. It lists other Radio Browser entries for the same station (the same
name, ignoring a trailing hint such as "128k" or "HD", and the same homepage),
up to 20, each with a **Play** button and its own label. Entries the directory
marks as broken are left out. Pick one by hand when the first stream sounds
poor or does not play. A station without a homepage lists stations with the
same name, and the list says they may be different stations. Items from your
own playlists have no **Other streams** button. A stream on the list can still
be dead at its provider. Only **Pick the best stream** set to **Auto
(verified)** ever moves a station to one of these entries by itself, as
described below.

### Pick the best stream

**Settings > Content > Pick the best stream** decides which of a station's
streams is tried first. It has three choices (the full rules are in [Using the
application](02-using-the-application.md#content)):

- **Listed streams** (the default): when a station or channel lists several
  streams, the best one is tried first: for TV the largest picture, for radio
  the highest bitrate up to 320 kbps, then the more efficient format. The best
  stream gets six seconds on its own; then, or at once if it fails, the next
  one is tried as well and whichever starts first plays. A stream that
  connects but never begins hands over to the streams not tried yet, at the
  latest 30 seconds after it connected. A stream that has begun gets 10 seconds
  from when it started to play one full second; after that, an interruption is
  handled by the reconnecting described above.
- **Auto (verified):** as **Listed streams**, and for a Radio Browser station
  also another directory entry of the same station, once background checks
  have verified that it is the same station and better. Two checks a few
  minutes apart must each find both streams playing the same song, a different
  song each time, so only a station that announces song titles can be
  verified; any other keeps its own stream. A verified stream is used from the
  next start of that station, with the station's own stream behind it. If it
  does not play, the station's own stream plays at once.
- **Off:** as in earlier versions, the first two listed streams are tried
  together and the first to answer plays.

Playing never changes the address a favorite is saved with.

### Sound meter

The player bar has a small LED-style sound meter beside **EQ**: 14 bars from
about 40 Hz on the left to about 16 kHz on the right, 10 to 12 segments high
(depending on the Windows display scale), each with a peak segment that holds for a moment and then falls. It is there so you
can see that something is really playing; it is not a measuring instrument.
It lifts quiet sound a little (up to 18 dB, adjusting over a few seconds) so
that a quiet station still moves the bars.

- It reads the sound after the equalizer, through a separate listening point
  that is not connected to the speakers. It never changes what you hear, what
  the EQ does, or what is recorded.
- It updates 15 times a second while something plays and the window is
  visible. It stops completely (no work at all) while playback is paused or
  stopped, while the sound is muted or the volume is at zero, and when it is
  switched off with **Settings > Appearance > Sound meter in the player bar**.
  While the window is minimized it slows to about one update a second. It also stays still when
  Windows is set to show fewer animations.
- It shows flat bars when the sound does not go through World Media's local
  relay and audio engine: when a stream has to be played directly because the
  relay could not be used (the EQ is unavailable then too), or while Windows
  has suspended the app's audio. A stream normally plays through the relay.
- The **Visualizer** tab reads the sound in the same way, so when the meter is
  flat, the Visualizer has no sound to follow either. See
  [Visualizer](09-visualizer.md).
- A recording reads the station separately. The meter shows what you hear.
- The large meter in **Now Playing** turns red and shows **Muted** when
  muted. Screen readers announce the change.

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

The Tuner's **Tone knobs** adjust the same EQ. **Bass** and **Treble**
adjust the low and high bands and **Loudness** adjusts preamp. With a
favorite playing, turning a knob saves a curve for that favorite. If
it was using an assigned preset, the first change starts from that curve.
Otherwise, the knobs adjust the main EQ. Point at a knob to see where
the change saves and its value in dB.
[Using the Tuner](02-using-the-application.md#tuner)

Built-in presets are Flat, Bass Boost, Treble Boost, Vocal, Spoken Word, Rock,
Classical, Jazz, Electronic, and Night. **New preset** creates a named custom
preset; custom presets can be renamed or deleted. **Reset to flat** sets the
current scope to a neutral curve.

Open **Stations...** to assign a preset to stations in **Favorites** or
**My Playlists**. Select the stations, choose a preset under **Use preset**,
then press **Apply to selected**. To use your current curve, first press
**Save new preset**. To remove assignments, choose **Clear preset
assignment** and press **Apply to selected**.

Open **Advanced** to set each band's Q from 0.25 to 8. Q sets the band width
and adjusts resonance on the 31 Hz and 16 kHz shelf bands. The defaults
preserve the equalizer's existing sound.

Web Audio applies smoothing to live playback. A boosted curve uses a limiter to
avoid clipping. If the same-origin relay or Web Audio signal cannot be made
safe, the app reports EQ unavailability rather than silently playing a muted
audio stream.

## Downloads

Download is available only for finite on-demand originals/derivatives. A live
HLS/DASH playlist is not treated as a finite download.

1. Select an item with a Download capability.
2. If the item has tracks or chapters, select the part you want. Press
   **Download** to save the selected part.
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

Files are sanitized and kept under the approved `downloads` root. The app
checks the Downloads folder for links and junctions before writing. Oversized,
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

The **Record** button's hover text, which screen readers also read as its
description, says why it cannot be pressed (for example "Recording is available
once this item plays."). **Record audio**, **Record video** and **Stop
recording** have the same width. The status area beside them shows **Preparing**,
then **Recording** with time and size, or **Saved** with size and time. Point at
the status for the full text.

The app chooses audio/video recording kind from the item or a bounded FFprobe
inspection. Video recordings require H.264/AAC-compatible output; audio uses
MP3. Output names are sanitized and collision-safe.

### Quality profiles

| Profile | Audio bitrate | Video ceiling | Video quality |
|---|---:|---:|---|
| Compact | 96 kbps | 480p | CRF 27 |
| Balanced (default) | 160 kbps | 720p | CRF 23 |
| High | 256 kbps audio (192 kbps in video) | 1080p | CRF 20 |

FFmpeg runs below normal priority on Windows so interactive playback remains
responsive.

### EQ in recordings

The EQ curve active when **Record** is pressed, including each band's Q,
is passed to FFmpeg and baked into the saved audio. Later changes to the player EQ, volume,
mute, or favorite scope do not rewrite an existing file. Bypass at recording
start produces an un-EQ'd recording.

### Turning Recorder off

Settings → Capture & storage → **Recorder** off prevents new recordings. If a
recording is running or FFmpeg is installing for one, the UI requests a stop or
cancel once; the recording is finalized/cancelled through the normal job state
machine. Downloads remain enabled. Re-enable the switch before starting a new
recording. With Recorder off, the Record button says **Recorder off**, and its
hover text says where to turn it on: Settings (the gear at the top), under
Capture & storage.

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
