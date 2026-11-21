# Open Media Explorer v0.1.13

Five requests from the discussion, three fixes for dragging favorites, four
more Visualizer scenes with new overlays and blends, and fixes.

- **Now Playing:** a new tab shows what plays now, large: its picture over a
  blurred copy, its name, the song a radio station announces (with a star and
  **Copy**), the stream details and a large sound meter.
- **Live radio and TV:** no more seek bar that does nothing. The time shows how
  long a station has played. Films, podcasts and files keep their seek bar.
- **Larger song title:** the song on the player bar is larger, bolder and
  brighter, grows with the window, and has more room on wide windows.
- **Did not play last time:** a small red **!** on the card of a favorite or a
  My Playlists station that did not play when you last tried it. It goes when
  the station plays.
- **Station pictures:** **Choose picture...** in a station's details, or drop a
  picture file on its card in Favorites or My Playlists, gives it a picture of
  your own.
- **Dragging favorites:** in **My order**, a card dropped anywhere on another
  card takes that card's place, and the "no entry" cursor is gone.
- **Visualizer:** four more scenes (103 in all), three calm overlays
  (**Ripples**, **Fireflies** and **Orbits**), the blends **Lighten** and
  **Color**, an **Extra glow** switch, and gentle drift of some overlay sizes
  with **Slow drift**.
- **Visualizer behind the Tuner:** **Settings > Appearance > Show the
  Visualizer behind the Tuner**, off by default, draws it faintly behind the
  Tuner while sound plays, with light scenes only.
- **Player bar:** a station's logo is shown whole, the record button is grayed
  out after a station failed to start, a station whose address does not exist
  says so, and **Play** stays and tries again. The sleep timer menu shows the
  choice that is running.
- **Tuner and Grid:** a refresh that fails keeps the stations a source had
  already listed, and an empty view caused by a failed source tries again by
  itself.
- **Fixes:** saving your favorites and settings, and pressing **Play**, no
  longer wait behind slow catalog loading. A picture the app refuses because of
  its address is not asked for again on every Grid visit. The Tuner and the
  Grid say "Loading 1 live source..." and never "from 0 sources".
- **Small changes:** the **Music:** line in the Visualizer is read from the
  sound's spectrum, overlay lines are thicker at Medium and High quality,
  Fireworks, Lasers, Stage Lights, Lightning and Spectrum stay over
  the effects, and the Visualizer panel is nearly opaque. A long name on a
  Favorites or My Playlists card takes two lines, and **Retry now** in the
  Library asks podcast feeds again at once.

Please note: the Visualizer shows moving, flashing pictures. A notice about
flashing lights and photosensitivity comes before the first picture, and a flash
limiter is always on, but it cannot rule out every risk. If you, or anyone
watching, may be sensitive to flashing lights or patterns, please use
discretion.

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) and the
requests in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.13-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.12
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
