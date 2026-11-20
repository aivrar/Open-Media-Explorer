# Open Media Explorer v0.1.12

The five requests promised in the discussion, a setting for how much of the
processor the app may use, 28 more Visualizer scenes, and fixes.

- **Starred songs:** star a song in the **Song log**, or the song playing now
  with the star on the player bar. **Starred songs** in the Song log panel
  lists them with the station and the time, to copy, look up on the web or on
  YouTube, or save as a text or CSV file. Up to 2,000 are kept. **Clear log**
  leaves them, and they are in backups.
- **Your own station names:** **Rename** in a favorite's details gives it a
  name of your own, shown in the Library, on the Tuner, on the player bar, in
  the song log and in starred songs. **Use original name** brings the old one
  back, and search finds either name.
- **Drag to reorder:** in Favorites with **My order**, drag a card before or
  after another. The Move buttons still work, also from the keyboard.
- **JSON and CSV playlists:** **My Playlists** imports `.json` and `.csv`
  channel lists, from a file, a dropped file or a web address. When a file
  cannot be read, the message says why, and for a broken file near which line.
- **Pick the best stream** (Settings > Content): **Listed streams**, the
  default, tries the best of a station's or channel's listed streams first
  and moves on to the next when it does not start. **Auto (verified)** also
  checks other Radio Browser entries of a radio station in the background, and
  uses one from the next start only after two checks a few minutes apart found
  it playing the same song as the station's own stream. The station's details
  say what the checks found, with **Use the station's own stream** to keep
  your own. **Off** works as before.
- **Processor use** (Settings > Processor use, and a section on the About
  page): **Low**, the default, is how the app has always behaved. **Balanced**
  and **High** let the Visualizer use more of the processor, up to a limit you
  set from 2% to 80%; the picture quality steps down when the app goes over
  it and back up when there is room. They also offer a **Very high** picture
  quality, sharper than High on large screens, and at High three simulations
  start one size larger. The limit is a target, not a hard cap: the sound is
  never held back to meet it.
- **Visualizer scenes:** 28 more, 99 in all: line drawings, simulations such
  as Fluid Ink and Physarum, five 3D flights, labs such as 2D Formula Lab and
  Buddhabrot Lab, and five scenes of World Media's own (Band Ridgelines, Sound
  Ring, Petal Bloom, Hex Weave and Contour Lines). Three labs have 28 more
  looks.
- **Visualizer effects and overlays:** the **Palette Map** effect recolors the
  picture (39 effects), and the **Strobe** overlay is a soft colored pulse on
  the beat, with a **Style** choice that is kept (26 overlays). **Slow drift**
  moves a few settings of the scene, its effects and the overlays slowly in
  time with the music, never its brightness.
- **Visualizer panel:** each section has a title bar that folds it and says
  what is set. Folded sections stay folded, and **Effects on** and **Overlays
  on** are always in view.
- **Visualizer mood:** read more carefully (one drum stroke counts once,
  hi-hats alone count half), and music reads as energetic sooner than before.
- **Fixes:** a live station whose connection closes now reconnects instead of
  going silent. With technical source details on, the source label on wide
  Favorites cards shows whole again. A Library catalog page that keeps failing
  now waits longer each time and stops after two failures until you press
  **Retry now**. An empty Tuner dial says when the stations could not be loaded,
  instead of "No stations found for this country." **Play** after a stream ended
  by itself connects again. Switches in Settings keep their size next to long
  text. A false "portable profile backup could not be updated" notice on a
  first start is gone.
- **Small changes:** larger Move buttons and Visualizer rows for the pointer,
  a long station name on the Tuner dial shows in full on hover, the
  media.ccc.de live list is read at most every five minutes and only while it
  is shown, and the app is in American spelling throughout. Backups also carry
  your station names and starred songs.

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
- `WorldMediaWindows-0.1.12-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.11
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
