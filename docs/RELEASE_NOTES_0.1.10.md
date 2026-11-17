# Open Media Explorer v0.1.10

Tuner fixes from a bug report, a sound meter in the player bar, and bigger
Tuner cards with station pictures.

- **Station pictures:** your own station pictures (from the `station-images`
  folder) that are not square were cut off. They are now shown whole and
  centred, on a plain background, in the player bar, the Library cards, the
  detail panel, Discovery and the Tuner cards. Other artwork looks as before.
- **Tuner dial:** the dial keeps the same size while you use it. It no longer
  grows and shrinks by a few pixels on some stations (a station name in another
  script made its card taller), it no longer jumps while the strip under it
  shows a message instead of cards, and it no longer becomes smaller the first
  time something is played after starting the app. Before the first play the
  Tuner now keeps room for the player bar, so in a window narrower than about
  1000 px the dial starts a little smaller than it used to: the size it keeps
  once something plays.
- **Sound meter:** small LED-style bars beside **EQ** in the player bar move
  with the sound, so you can see that a station is really playing: 14 bars,
  from deep bass on the left (about 40 Hz) to treble on the right (about
  16 kHz). The meter only reads the sound and never changes what you hear. It
  rests completely while playback is paused or stopped and while the sound is
  muted or at zero, and it slows to about one update a second while the window
  is minimised. In a window up to
  1000 px wide it sits at the end of the button row. Turn it on or off with
  **Settings > Appearance > Sound meter in the player bar**; it is on by
  default.
- **Tuner knob:** the knob shows only the station's name. The source, for
  example "My Playlist", is no longer added after it; it is still shown on the
  station's card under the dial.
- **Tuner card size:** **Settings > Appearance > Tuner card size** offers
  **Small** (as before, the default), **Medium** and **Large**. Medium and
  Large cards have bigger names and show the station's picture: your own
  station picture, otherwise the station's logo, otherwise its initials.
  Pictures load only for the cards you can see, after the dial stops turning.

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) and the
requests in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.10-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.9
remains available for rollback, and going back to v0.1.9 keeps your favorites
and settings.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
