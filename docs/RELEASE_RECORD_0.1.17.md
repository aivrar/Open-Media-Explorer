# v0.1.17 release verification - 2026-11-25

This release adds a video picture panel, export and backup stream addresses,
song titles in Favorites, audio parts, more EQ and appearance controls, and
smoother Visualizer scene changes. See the [release notes](RELEASE_NOTES_0.1.17.md).

## What changed and why

- **Video picture and controls.** The **Picture** panel keeps color and fit
  choices for all video or for a saved channel. Live TV hides the timeline
  for the station's short live window. A finite stream gets its timeline.
  Video and HLS details appear once the app knows them from playback.
- **Saved stations.** Favorites and My Playlists can export what is shown.
  Edited addresses can carry backups. **Show what's playing** reads the song
  directly from visible radio Favorites that send one. The short title
  reported by TaxicabMessiah came from the station's own track data.
- **Layout.** Lists leave scroll room for the picture. The Tuner reserves
  room for it in one movement. Recording controls stay aligned when switching
  between radio and TV, and Settings, EQ and the Song log scroll above the bar.
- **Listening controls.** Audio with several tracks or chapters plays through
  in order and remembers where you stopped. EQ can assign a curve to several
  stations and adjust Q per band. Settings can hide tabs and change the
  Now Playing background blur.
- **Visualizer.** The shuffle listens for song structure, scenes dissolve,
  **Color travel** shifts the palette slowly and DIFS Tunnel Flight is brighter.
- **Live starts, saves and local files.** The relay passes live bytes on as they
  arrive. A stalled AAC start releases its held bytes after 1.5 seconds. A
  cancelled start only cancels its own session lookup. Settings wait for the
  profile to finish restoring. Relayed content is sandboxed, and the Downloads
  folder is checked for links and junctions before writes.

## Evidence

- `npm test` reported 1,934 passing JavaScript tests. Python unit tests
  reported 742 passing tests and 8 skips for Windows symlink permissions.
  Lint passed.
- Findings from eight review rounds and one final layout review were fixed.
- In the release build's window at 1024 × 640, 1280 × 800 and 1920 × 1080,
  **EQ** and **Record** stayed in the same positions for radio and TV.
  Settings, EQ and the Song log stayed above the player bar.
- Brightness, saturation and hue were measured on live video. **Reset**
  left no filter, and the channel's settings survived a restart. Fit and
  zoom stayed inside the picture box and applied in fullscreen. Live video
  hid the timeline. On-demand video kept its timeline and could seek.
  Stream details appeared on four live channels.
- TV-only, radio-only and all-type exports were checked, along with re-import
  of 12 stations. A stream address was edited with a backup. **Show what's
  playing** was checked on eight stations, with the song first. A radio
  recording and a TV recording were made.
- At 1280 × 800, the Tuner dial moved once from 471 to 283 px in 196 to
  199 ms and kept its size between TV channels. At 1024 × 640, the dial
  measured 190 px with a 200 × 112 picture.
- Seven of seven Visualizer scene changes dissolved. The largest
  frame-to-frame brightness step was 0.05 of full scale. DIFS Tunnel Flight
  brightness was also checked.
- With a station playing on the test machine, processor use was about 10.6%
  of one core with the Visualizer tab closed, 14.5% open, and 16.4% open with
  song structure and **Color travel**, at 60 frames per second.
- Across 40 station starts on the test connection, starts took 0.6 to
  3.0 seconds, with HLS at about 4.7 seconds.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,737,383 | `C96EC5717F5331B8F206C10F1D67388F9D9754A00F463C5C219DB3D37440B527` |
| `WorldMediaWindows-0.1.17-portable.zip` | 15,484,137 | `1D433FF21EA6BC806EDE4D3FD53766926A52A31934590A6C8DC39696E986607A` |

## Boundaries

- Stream details depend on what the stream reports. Radio song titles use
  the station's own data.
- Picture settings affect playback on screen. Downloads and recordings use the
  source stream.
- FLAM3 Density Lab, IFS / L-System Lab, Attractor Density Lab and Hypercomplex
  Slice Flight remain held back.
