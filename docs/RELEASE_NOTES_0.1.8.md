# Open Media Explorer v0.1.8

Tuner dial fixes from user feedback, plus a few small visual fixes.

- **One station on the dial:** with a single station, the dial now stays put.
  Arrow keys, the mouse wheel and dragging no longer turn it or restart the
  station. If nothing is playing, an arrow key still starts it.
- **The marker lines up:** the knob now rests at the same angle for the same
  station, so the first station is always at the top. Before, going round the
  list or letting go of a drag between two stations could leave the marker
  pointing anywhere.
- **No needless restarts:** clicking or releasing the dial on the station that
  is already playing no longer restarts it.
- **Dial fits the window:** in a short window the dial was cut off at the top
  and bottom. It now shrinks to fit, and the station name stays inside the
  knob. The small dot behind the station number is gone.
- **Playlist wording:** the drop hint now says `.m3u or .m3u8`, and the button
  is **Import playlist**. Both file types were already accepted.
- **Initials in the player bar:** an item without artwork shows its initials
  there, the same as on the cards.
- **Settings:** the Local port box matches the other controls.

Not in this release: `.pls` and `.xspf` playlists, a "star all" button for a
playlist, custom station images, dial highlighting, and the search for a
higher-quality stream. These are feature requests and are noted for later.

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.8-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.7
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
