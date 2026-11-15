# Open Media Explorer v0.1.9

Feature requests from users, a backup button, and live streams that reconnect
by themselves.

- **Favorites and playlists:** the media type is now a row of buttons (**All**,
  **Radio**, **TV**, **Audio**, **Video**) instead of a drop-down. Sort
  Favorites by **My order** or **A-Z**. In My order, every card has buttons to
  move it up, move it down, or move it to the top, and the Tuner follows the
  same order. Make your own categories, for example "Rock" or "Talk", put a
  favorite in one with the tag button on its card, and show one category at a
  time. The Tuner's Source list offers each category. **Star all** adds all the
  channels listed in My Playlists to Favorites. Playlist import now accepts
  `.pls` and `.xspf` files too, with the file picker, with drag and drop, and
  as an online link.
- **Tuner and player:** the dial glows when the mouse is over it and the wheel
  can turn it. The station cards under the dial can always scroll to the
  centre, including the first and the last station. The speaker button shows a
  crossed-out speaker when the sound is muted or the volume is at zero, and
  the volume slider shows its value as a percentage when you point at it.
  Live radio and TV now reconnect by themselves after a dropped connection
  ("Connection lost. Retrying...", for up to ten minutes). A radio stream that
  silently freezes is noticed after about 20 seconds and restarted.
- **Song title and song log:** a radio station that sends the title of its
  current song shows it under the station name in the player bar, with a note
  sign, and in the Windows media overlay. Not every station sends titles.
  Stations that are delivered as HLS do not show one, and some stations send
  jingles or filler text. The note button at the top right opens the song log:
  the time, station and title of the songs you heard, with **Copy**,
  **Remove**, **Save to file** (a CSV file in the downloads folder) and
  **Clear log**.
- **Station images and stream quality:** **Settings > Station images > Open
  folder** opens a `station-images` folder inside the data folder. A picture
  named exactly like a station (PNG, JPG, WebP or GIF, up to 2 MB) replaces
  that station's artwork after **Refresh**. Radio Browser stations now show
  their format and bitrate, for example "MP3 · 128 kbps", in the detail panel.
  **Other streams** lists other listings of the same station to pick from by
  hand. Nothing switches automatically.
- **Backup:** **Settings > Storage > Back up my data** writes one ZIP into the
  downloads folder. It holds your favorites, settings, equalizer curves,
  categories, song log, imported playlists and station images, plus `.m3u8`
  playlist files that other players can open. There is no restore button: to
  restore, close the app and copy the `WorldMediaWindows-data` folder from the
  ZIP back. Playlist addresses can contain private links or account tokens, so
  share the ZIP only with people you trust.
- **Fixes:** a Library search with no results no longer leaves a blank loading
  area. Choosing one source right after opening no longer restarts loading for
  every source. **Retry now** and the explicit-content switch no longer leave a
  source stuck. The status texts in the player bar fit in a small window, and
  "Checking..." no longer stays forever after a failed Play. Relays left behind
  by a rejected download or recording start, or by a page reload, are now
  released.
- **Sources:** Library of Congress was removed. Its website now refuses
  requests from apps like this one. The app has ten sources. Library of
  Congress favorites stay in the list and say "Source no longer available."
  when they cannot play.

Thanks to TaxicabMessiah for the requests in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.9-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.8
remains available for rollback, and going back to v0.1.8 keeps your favorites
and settings.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
