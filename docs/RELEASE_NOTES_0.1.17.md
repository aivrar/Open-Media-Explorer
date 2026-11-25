# Open Media Explorer v0.1.17

The player bar has a **Picture** panel for video and TV. You can export saved
stations, edit stream addresses and add backups, and see what Favorites are
playing. The equalizer can assign presets to several stations at once, and the
Visualizer times scene changes to the music. Low-bitrate live streams start
sooner.

- **Video and TV.** Use **Picture** next to **EQ** to change the picture and
  choose **Fit**, including zoom for black bars. Save your choices for a
  channel or for all video. Live TV hides the video's timeline. Video and HLS
  streams get more stream details after they play. The Tuner centers TV video
  beneath the station strip, and lists leave room to scroll past the picture.
- **Favorites and My Playlists.** **Export...** writes the current selection
  as M3U8 or JSON. **Stream address...** edits a saved station's address and
  adds up to five backups. **Show what's playing** reads the titles of your
  radio Favorites from the stations. Disabled sources are dimmed and listed last.
- **Parts.** Internet Archive audio tracks and LibriVox chapters play in
  order. You can skip between them, resume where you stopped or download a
  single part.
- **Player and settings.** **Now Playing background blur** has four levels
  and the large meter shows **Muted**. The player bar reserves room for
  recording status, and Settings, EQ and the Song log scroll above the bar.
  **Tabs shown** lets you keep the tabs you use.
- **Equalizer.** **Stations...** assigns or clears presets for several saved
  stations at once. Save the current curve as a preset to assign it.
  **Advanced** sets Q per band.
- **Visualizer.** Shuffle uses the music's structure to time scene changes,
  scenes dissolve, and **Color travel** drifts the palette with the music.
  DIFS Tunnel Flight is brighter. FLAM3 Density Lab, IFS / L-System Lab,
  Attractor Density Lab and Hypercomplex Slice Flight remain held back.
- **Fixes.** Low-bitrate live audio starts sooner, a cancelled start cannot
  cancel another start's session lookup, and the app waits for profile restore
  before saving. The local relay and downloads folder have stricter safety checks.

Thanks to TaxicabMessiah for the ideas and reports.
[Discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
and [issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) have the
original requests. The short song title reported in issue #6 came from the
station's own track data. World Media shows what the station sends.

## Download and update

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,737,383 | `C96EC5717F5331B8F206C10F1D67388F9D9754A00F463C5C219DB3D37440B527` |
| `WorldMediaWindows-0.1.17-portable.zip` | 15,484,137 | `1D433FF21EA6BC806EDE4D3FD53766926A52A31934590A6C8DC39696E986607A` |

The one-file EXE is unsigned. The ZIP is the complete portable folder with the
signed Python runtime launcher. Extract the entire package and keep its files
together. `SHA256SUMS.txt` lists checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the
single-file version, replace only the EXE and keep your data, downloads and
tools. [v0.1.16](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.16)
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
