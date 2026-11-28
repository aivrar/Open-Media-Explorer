# Open Media Explorer v0.1.19

The new **Computer** tab plays music, films, shows and audiobooks from folders
you add. Search for your files in the Library, save favorites and pick up an
audiobook where you stopped.

- **Computer.** Use **Add folder...** to add up to 200 folders, including
  their subfolders. Browse music by **Albums**, **Artists**, **Songs**,
  **Genres** or **Folders**, with covers from the files or the folder. Browse
  video by **Movies**, **Shows**, **All videos** or **Folders**. Movies have
  posters and a details panel, shows are grouped by season, and audiobooks
  have chapters when available. Search, sort, use **Play all** or **Shuffle**,
  and move through the queue with **Previous** and **Next**.
- **Album covers.** Album covers for a large library fill in quickly,
  and songs can start while covers load.
- **Switching files.** The current item keeps playing until the new file is
  ready. If the file cannot be opened, the app shows a short message and
  keeps playing the current item.
- **Favorites.** Use the star button or press **F** on a song, album, artist,
  film or show. Starred files appear in **Favorites** on Computer and in
  **Library > Favorites**. Library search labels your files **Computer**.
  Use **Audio** or **Video** to narrow the results.
- **Formats.** MP3, AAC / M4A, FLAC, PCM WAV, Ogg Vorbis and Opus play
  directly when the player supports the file. FFmpeg converts other formats
  for playback with seeking. Examples include AIFF, ALAC, APE, WavPack,
  DSD, WMA, AC-3 and DTS for sound, and MPEG-2 / DVD VOB, AVI, WMV,
  HEVC and other MKV or MP4 variants for video. The app uses the graphics
  card's encoder when available. For DVD VOB files with restarting timestamps,
  the app can rebuild the timeline for the true length and exact seeking.
  Use an existing capable FFmpeg pair or confirm the install in Settings.
- **Subtitles and audio tracks.** Open **Subtitles** in the player bar.
  Press **C** to turn subtitles on or off. The app reads .srt, .vtt and .ass
  files beside the film or in a **Subs** folder, and text subtitles inside
  the film. It reads older Cyrillic, Greek, Turkish, Central European and
  Baltic encodings and pairs each subtitle file with the film whose name is
  the longest match. Choices are remembered per film and by language.
  Picture-based DVD and Blu-ray subtitles are unavailable.
  Use **Audio** to switch sound tracks, such as stereo, 5.1,
  another language or commentary. The app remembers your choice.
- **Volume levelling and gapless albums.** In **Settings > Playback**,
  choose **Off**, **Track** or **Album** and set the **Pre-amp** when levelling
  is on. The app uses ReplayGain tags or measures untagged songs in the
  background, one song ahead. The player prepares the next song of an album
  so it can start as the current one ends. When nothing is playing, the app
  uses almost no processor time. Sound processing pauses after a few seconds
  of silence.
- **Large collections.** The app handles tens of thousands of files
  (tested with 50,000 files). A scan reuses what it read from unchanged files.
  A disconnected folder stays in the list. Use **Locate...** to point to
  its new location, for example after a drive letter change. Renamed or
  moved files keep their stars when the app can match them.
- **Light theme.** The scrollbar and switches that are off are easy to see.
  Pale channel logos stay visible in the player bar and appear larger on
  a grey tile in the Tuner's picture box.
- **Library details.** In small windows, the details pane stays clear of
  the video box.
- **Tabs.** The order is **Library**, **Tuner**, **Computer**, **Now Playing**,
  **Visualizer** and **About**. Library covers the live stations from Grid.
  Turn on **Surprise me** in **Now Playing** for a random pick from your
  enabled sources. Library opens if Grid or Discovery was your saved start
  tab. Hide Computer under **Settings > Appearance > Tabs shown**.

## Fixes from user reports (issue #6)

- **Playlist import.** A playlist that points to another channel list on the
  web now brings in that list's channels. The app follows up to four links
  per import, one level deep, and imports up to 5,000 channels. If a linked
  list cannot be loaded, its link stays as one entry and the import message
  says so.
- **Text fields.** Right-click for **Undo**, **Cut**, **Copy**, **Paste** and
  **Select all**.
- **Stream addresses.** Press **Up** on the first backup to make it the main
  address. Adding, removing or reordering backups keeps the stream format
  and quality. Changing the main address clears them.
- **Station pictures.** A picture you set belongs to that station, even when
  a radio station and a TV channel share a name.
- **Video box.** The dark blur over **Play** and **Fullscreen** is gone.
- **Library.** Clearing what you typed in Search, Country or Language takes
  you back to where you were. A count beside the filters shows how many
  channels, stations or items match, with "so far" while sources load. A
  clicked card stays in place when its details open. The Language box accepts
  codes and names such as `en`, `eng` and `English` and works for iptv-org TV.
- **Tuner.** Clicking a station that is already in view leaves the list in
  place.
- **Saved stations.** An address that answers without ever sending a stream
  counts as a failed start. The app tries the backups and marks the station
  "Did not play last time" if none start.

## Download and update

The one-file EXE is unsigned. The ZIP is the complete portable folder with the
signed Python runtime launcher. Extract the entire package and keep its files
together. The downloads are `WorldMediaWindows.exe` and
`WorldMediaWindows-0.1.19-portable.zip`.

Close the old app and back up **WorldMediaWindows-data** first. For the
single-file version, replace only the EXE and keep your data, downloads and
tools. [v0.1.18](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.18)
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
