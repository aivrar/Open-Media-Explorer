# Open Media Explorer v0.1.3

Bring your own channels and find your favorites faster.

- **My Playlists:** import local M3U/M3U8 channel lists for TV or internet radio.
- **Add link:** paste a named direct stream or import an online M3U channel list.
- **Organized Favorites:** separate Radio, TV, Video, and Audio, with local search.
- **Safer saved data:** reject incomplete port-change backups, preserve Favorites
  when a write fails, and show save/backup warnings instead of silent failures.
- **More reliable shutdown:** acknowledge immediately, finish cleanup once, and
  avoid misleading Retry messages after an accepted shutdown.
- **Artwork recovery:** stalled thumbnails release their queue slot; zero sidebar
  counts remain visible.

Thanks to @TaxicabMessiah for the playlist-import and Favorites-organization
suggestions in [issue #1](https://github.com/aivrar/Open-Media-Explorer/issues/1).
More feedback and suggestions are always welcome.

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.3-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. Do not replace
your data with a fresh test profile. v0.1.2 remains available for rollback.

Imported lists live in Library/My Playlists and Favorites, not Grid/Tuner/Discovery.
Online imports are snapshots, not auto-refresh subscriptions. Use **Single channel**
for a direct HLS manifest; provider login pages, DRM, and private-network streams
are not supported. Playlist URLs/headers can contain tokens: keep them private.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
