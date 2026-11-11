# Open Media Explorer v0.1.7

Three fixes from user feedback.

- **Drop a playlist file to import it:** dropping a local `.m3u` or `.m3u8`
  file anywhere on the window now imports it into **Library → My Playlists**,
  the same as the **Import M3U** button. Before, Windows opened the file in
  Notepad. Dropped on the Tuner, new channels are added as the band the dial is
  on (Radio or TV). Star the stations you want on the dial.
- **No empty video square on radio:** a few radio stations stream in a video
  format but send sound only. They no longer open an empty video square. TV and
  video play in the in-app video square exactly as before.
- **Tuner keeps your station in view:** the row of stations under the dial now
  stays centred on the current station instead of letting it scroll out of
  sight.

Not in this release: showing the current song, and saving songs to a list.
Both were suggested in the same report and are noted for later.

Thanks to TaxicabMessiah for the report in
[issue #5](https://github.com/aivrar/Open-Media-Explorer/issues/5).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.7-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.6
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
