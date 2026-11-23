# Open Media Explorer v0.1.16

Stream format and bitrate for stations from any source once they have played,
a fix for live AAC stations that failed on some starts, a compact volume
control, a one-row player bar, and one running copy per data folder.

- **Stream format and bitrate on any station that has played.** With **Show
  technical source details** on, a station from a playlist showed nothing,
  because only Radio Browser lists a format and bitrate. The app now remembers
  what a station's own stream says, for example "AAC+ · 320 kbps", once the
  station has played. It shows in the tooltip of the station in the Library and
  the Tuner, in its details and, with the setting on, on its card. A station
  shows it after it has played once, unless Radio Browser lists it; HLS
  stations show none.
- **Live AAC stations start at a whole sound frame.** A Shoutcast server can
  start a new listener in the middle of a sound frame, and about one start in
  five or six of Radio Caprice - Trip Hop failed with a decode error. A live AAC
  stream now starts at its first whole frame. 12 of 12 starts of that station
  played in the release build.
- **Live audio starts a little sooner:** the first bytes came 0.3 to 0.5
  seconds sooner on four stations.
- **Compact volume control.** The slider is replaced by an up button, the
  volume as a number, and a down button beside the speaker button. A click
  changes the volume by 1, a held button repeats, the mouse wheel over the
  control changes it by 2 per notch, and the arrow keys, Page Up, Page Down,
  Home and End work too. Changing the volume with a video's own controls now
  updates the bar, and a volume you set while the sleep timer fades the sound
  is kept.
- **Player bar in one row,** 74 px high where it was 96. The line of text under
  the buttons is gone: the **Record** button's hover text says why it is
  unavailable (with Recorder off, where to turn it on), and a capture's progress
  or result shows beside it. The **Open Settings** button is removed; the gear at
  the top opens Settings.
- **Tuner.** The mouse wheel over the strip of station cards moves one station
  per notch, like the dial. A new **Visualizer:** control at the right of the top
  bar sets how strongly the Visualizer shows behind the Tuner, from 0 to 100; 0
  turns it off, and 8, the default, is the look it had.
- **One copy per data folder.** Starting the app again while it runs with the
  same data folder brings the open window to the front instead of opening a
  second one. Copies with different data folders still run side by side.

Everything else is as in
[v0.1.15](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.15).

Thanks to TaxicabMessiah for the report in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.16-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.15
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
