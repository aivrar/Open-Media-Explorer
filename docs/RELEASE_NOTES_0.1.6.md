# Open Media Explorer v0.1.6

Three small interface improvements from user feedback.

- **Switched-off sources leave the sidebar:** a source you turn off in
  Settings is no longer shown greyed out in the Library sidebar. Turn it back on
  in Settings and it returns.
- **Mouse wheel on the Tuner dial:** scroll over the dial to move one station
  per notch. The station starts playing when the wheel comes to rest. Dragging
  and the arrow keys work as before.
- **Dial drag fix:** dragging the dial across the 9 o'clock position no longer
  jumps 30 stations.
- **Bigger video on big screens:** the floating video grows with the window. It
  is the same 320 px on a 1080p-wide window and up to 640 px on a 4K-wide one.
  Hover the video and use the button in its top-right corner to switch to a
  larger size; the choice is remembered.
- **FFmpeg install works again:** the optional FFmpeg install in Settings (used
  for recording) failed with "GitHub release repository identity is invalid"
  because the FFmpeg build project moved to a new GitHub address. The app now
  uses the new address. An FFmpeg you already have installed was not affected.

Thanks to TaxicabMessiah for the observations in
[issue #4](https://github.com/aivrar/Open-Media-Explorer/issues/4).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.6-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.5
remains available for rollback.

The v0.1.6 downloads were replaced later on 10 November 2026 to add the FFmpeg
install fix. If your copy does not match `SHA256SUMS.txt`, download it again.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
