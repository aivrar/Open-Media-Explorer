# Open Media Explorer — User Wiki

This is the end-to-end guide for the Windows-native World Media application.
It covers version 0.1.19. Learn to install the app, browse ten public
sources, play your own files, use the equalizer and Visualizer, download
or record media, and keep your data when you update.

Online sources supply their own catalogs and streams. Their stations,
channels, episodes and archive records can change between visits.

![World Media Library with its public sources](<../../screenshots/v0.1.14/library.png>)

![World Media Tuner with the radio dial, tone knobs and station list](<../../screenshots/v0.1.14/tuner.png>)

![Ten-band equalizer with presets](<../../screenshots/v0.1.14/equalizer.png>)

![Visualizer - Black Hole with Lasers and Tron Hex Grid](<../../screenshots/v0.1.14/visualizer-black-hole.jpg>)

## New in 0.1.19

- **Computer** plays music, films, shows and audiobooks from folders you add.
  Browse covers and posters, play chapters, and pick up where you stopped.
  Star files to see them in Computer and Library **Favorites**.
- Library search finds your own files. **Subtitles** and **Audio** let you
  change tracks in a film. **Volume levelling** evens out music, and the player
  prepares the next song of an album for a gapless start.
- **Surprise me** in **Now Playing** plays a random pick from enabled sources.
  [Using the application](02-using-the-application.md)

## New in 0.1.18

- The Tuner has a station list beside the dial and the optional **Bass**,
  **Treble** and **Loudness** knobs. The TV picture sits above the list.
  **Stations** and **Tone knobs** remember what you show. The Visualizer
  background also works during TV and video playback.
  [Tuner](02-using-the-application.md#tuner)
- The **Picture** panel has **Quality** for streams with at least two
  levels. Choose **Auto**, **Best available** or a fixed level.
  [Picture quality](04-playback-eq-downloads-recording.md#picture-quality)
- The player bar gives up room in a fixed order before using a second
  row. The main header and Tuner bar have even control spacing.
  [Window layout](02-using-the-application.md#window-layout)
- A picture drag highlights the card under it, and dragging a Favorite
  near an edge scrolls the list. Video controls have lighter shading,
  and switching video channels keeps your scroll position. **Pick the best
  stream** explains each choice in a short list.
  [Using the application](02-using-the-application.md)

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

## New in 0.1.17

- Set the picture and fit for video and TV, including fullscreen. Live TV
  hides its timeline and video and HLS show more stream details.
  [Playback](04-playback-eq-downloads-recording.md#player-controls)
- Export the current Favorites or My Playlists view, edit saved stream
  addresses with backups, and see what's playing on radio Favorites.
  [Library](02-using-the-application.md#library)
- Play Internet Archive tracks and LibriVox chapters in order, resume
  later or download one part.
  [Tracks and chapters](04-playback-eq-downloads-recording.md#tracks-and-chapters)
- Assign a preset to several stations and set Q per band.
  [Equalizer](04-playback-eq-downloads-recording.md#equalizer)
- Hide tabs with **Tabs shown** or adjust **Now Playing background blur**.
  [Appearance](02-using-the-application.md#appearance)
- Visualizer scenes dissolve and shuffle with the music's structure.
  **Color travel** shifts the palette, and DIFS Tunnel Flight is brighter.
  [Visualizer](09-visualizer.md)
- Low-bitrate live stations start sooner, and a cancelled first play no
  longer interrupts another start.
  [Troubleshooting](06-troubleshooting.md#a-station-starts-slowly)

Thanks to TaxicabMessiah for the ideas and reports.
[Discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8) ·
[Issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)

## New in 0.1.16

- A station's stream format and bitrate show for stations from any source once
  they have played, not only for those Radio Browser lists. See [Playback, EQ,
  downloads, and
  recording](04-playback-eq-downloads-recording.md#stream-format-and-other-streams).
- The volume slider is a compact control (up, a number, down) and the player
  bar gained a one-row layout. See [Using the
  application](02-using-the-application.md#window-layout).
- The Tuner gained one-station wheel steps and a
  **Visualizer:** control in the Tuner's top bar sets how strongly the
  Visualizer shows behind it. See [Using the
  application](02-using-the-application.md#tuner) and
  [Visualizer](09-visualizer.md#the-visualizer-behind-the-tuner).
- A live AAC stream starts at its first whole sound frame, which fixes failed
  starts on some Shoutcast stations. See [Architecture and runtime
  reference](08-architecture-and-runtime-reference.md#stream-facts-and-the-start-of-a-live-stream).
- One copy runs per data folder: starting the app again brings the open window
  to the front. See
  [Troubleshooting](06-troubleshooting.md#starting-world-media-a-second-time)
  and [Architecture and runtime
  reference](08-architecture-and-runtime-reference.md#one-copy-per-data-folder).

## New in 0.1.15

- Radio Browser stations load much faster: the Library asks for 300 at a time
  where it asked for 30. Lists are sent compressed. See [Sources and
  channels](03-sources-and-channels.md#provider-pacing-and-caching).
- A server with several addresses, one of them dead or slow, no longer holds a
  stream or a list up: the app tries the addresses together. See [Architecture
  and runtime
  reference](08-architecture-and-runtime-reference.md#playback-and-relay-boundary).
- After the connection drops, sources that failed are asked again by
  themselves when it comes back, in the Library and the Tuner. See
  [Troubleshooting](06-troubleshooting.md).
- Owncast and the media.ccc.de live rooms are listed from the start, whichever
  Library view is open.
- Podcast episodes published as M4A, AAC, Ogg, Opus, FLAC, WAV, WebM, M4V and
  MOV are listed and play. More media.ccc.de, Wikimedia Commons and Internet
  Archive recordings play. See [Sources and
  channels](03-sources-and-channels.md#which-file-of-an-item-plays).

## New in 0.1.14

- Stations on an old Shoutcast server (version 1), which did not play although
  their address worked in a browser or another player, now play, show their
  song titles and can be recorded.

## New in 0.1.13

- **Now Playing:** the new tab shows what
  plays now, large: its picture over a blurred copy, its name and category, the
  song a radio station announces (with a star and **Copy**), **Stream details**
  and a large sound meter. See [Using the
  application](02-using-the-application.md#now-playing).
- Live radio and TV no longer show a seek bar or a length; the time shows how
  long the station has played. The song on the player bar is larger, bolder and
  brighter, and it and the station name grow with the window. See [Playback,
  EQ, downloads, and
  recording](04-playback-eq-downloads-recording.md#player-controls) and [Using
  the application](02-using-the-application.md#window-layout).
- A small red **!** marks a favorite or a My Playlists station that did not play
  the last time you tried it, and goes when the station plays. See [Using the
  application](02-using-the-application.md#did-not-play-last-time).
- **Choose picture...** in a station's details, or dropping a picture file on
  its card, gives a favorite or a My Playlists station a picture of your own.
  See [Using the
  application](02-using-the-application.md#station-images) and [Data, cache,
  and portability](05-data-cache-and-portability.md#station-images).
- In **My order**, a card dropped anywhere on another card takes that card's
  place. See [Using the
  application](02-using-the-application.md#favorites-order).
- **Settings > Appearance > Show the Visualizer behind the Tuner** (off by
  default) was added to draw the Visualizer behind the Tuner. See
  [Visualizer](09-visualizer.md#the-visualizer-behind-the-tuner).
- The Visualizer has four more scenes (103 in all), the overlays **Ripples**,
  **Fireflies** and **Orbits**, the **Lighten** and **Color** blends, an
  **Extra glow** switch, overlays that drift with **Slow drift**, and a mood
  line read from the sound's spectrum. See [Visualizer](09-visualizer.md).

## New in 0.1.12

- **Starred songs:** star a song in the **Song log**, or the song playing now
  with the star beside it on the player bar. **Starred songs** in the Song log
  lists them, and **Save as text** or **Save as CSV** writes them to a file.
  **Clear log** leaves them. See [Using the
  application](02-using-the-application.md#song-log).
- Favorites: **Rename** in a favorite's details gives a station a name of your
  own, shown everywhere that favorite is. In **My order** you can drag a card
  to a new place. **My Playlists** also imports `.json` and `.csv` channel
  lists. See [Using the application](02-using-the-application.md).
- **Settings > Content > Pick the best stream:** when a station lists several
  streams, the best one is tried first. **Auto (verified)** can also move a
  radio station to a better directory entry of the same station, but only
  after two checks found both playing the same song. A live station whose
  connection closes now reconnects by itself. See [Playback, EQ, downloads, and
  recording](04-playback-eq-downloads-recording.md).
- **Settings > Processor use:** **Low** (the default), **Balanced** or
  **High**, with a limit you set. Balanced and High let the Visualizer use
  more of the processor and offer a **Very high** picture quality. See [Using
  the application](02-using-the-application.md#processor-use).
- The Visualizer has 28 more scenes (99 in all), 28 more looks for three of its
  labs, the **Palette Map** effect, the **Strobe** overlay, **Slow drift**, a
  more careful reading of the music's mood, and a side panel whose sections
  fold and say what is set. See [Visualizer](09-visualizer.md).
- Fixes: a Library source whose pages keep failing now waits longer each time
  and stops after two failures in a row until you press **Retry now**;
  **Play** after a stream ended by itself connects again; with technical
  details on, Favorites cards in **My order** are wide enough for their whole
  source badge; and a long station name on the Tuner dial shows in full when
  the pointer rests on it.

## New in 0.1.11

- A new **Visualizer** tab shows pictures that move with the sound of whatever
  is playing: 71 scenes, post effects, overlays, a shuffle, favorites, and an
  automatic step-down for weak computers. It shows moving, flashing pictures, so
  a notice about photosensitivity comes first. See
  [Visualizer](09-visualizer.md).
- Importing a playlist now starts on **Add as: Auto**, which works out radio or
  TV by itself, and the import result says what it chose when some channels
  needed a type from **Add as**. Importing the same playlist again as Radio
  moves its TV favorites over (and the other way round). The Tuner tells you
  when some of your favorites are saved as the other type. See [Using
  the
  application](02-using-the-application.md) and
  [Troubleshooting](06-troubleshooting.md).
- A station picture now matches a station whose name has a character a file name
  cannot have (such as "/"), and Settings lists the pictures that were not used.
  Favorite cards have a **Move to bottom** button, and **Remove all favorites**
  asks first. See [Using the application](02-using-the-application.md).
- Fixes: the player bar no longer jumps sideways on every station change, own
  playlist channels no longer show "See provider terms", four-letter initials
  fit on Tuner cards, and the Light theme's slider tracks are visible.

## New in 0.1.10

- A small sound meter beside **EQ** in the player bar shows that something is
  really playing. Switch it in **Settings > Appearance > Sound meter in the
  player bar**. See [Playback, EQ, downloads, and
  recording](04-playback-eq-downloads-recording.md).
- **Settings > Appearance > Tuner card size** adds Medium and Large
  station entries with pictures. The knob shows only
  the station's name. See [Using the
  application](02-using-the-application.md).
- Fixes: your own station pictures are shown whole instead of cut off, and the
  Tuner dial keeps the same size between stations, while a list loads, and on
  the first play.

## New in 0.1.9

- Favorites can be sorted **My order** or **A-Z** and grouped in your own
  categories, and the media type is a row of buttons. **Star all** and `.pls`
  and `.xspf` import are new in My Playlists. See [Using the
  application](02-using-the-application.md).
- The player bar shows the song a radio station is playing (when it sends
  one), and the **Song log** keeps a list of the songs you heard. Live radio and
  TV reconnect by themselves, and Radio Browser stations show their stream
  format and bitrate. See [Playback, EQ, downloads, and
  recording](04-playback-eq-downloads-recording.md).
- You can give stations your own pictures, and **Back up my data** in Settings
  writes one ZIP with your favorites, settings, playlists and more. See [Data,
  cache, and portability](05-data-cache-and-portability.md).
- Library of Congress is no longer a source, so the app has ten. See [Sources
  and channels](03-sources-and-channels.md).

## Start here

| If you want to… | Read |
|---|---|
| Install the EXE or move it to another drive | [Installation and portable data](01-installation-and-portable-data.md) |
| Learn the six tabs, sidebar, filters, and settings | [Using the application](02-using-the-application.md) |
| Use the Visualizer, keep it light on a weak computer, or read about its flashing notice | [Visualizer](09-visualizer.md) |
| Understand every source and its channel/catalog behavior | [Sources and channels](03-sources-and-channels.md) |
| Play a stream, fix a broken stream, use EQ, download, or record | [Playback, EQ, downloads, and recording](04-playback-eq-downloads-recording.md) |
| Understand favorites, cache, profile migration, and backups | [Data, cache, and portability](05-data-cache-and-portability.md) |
| Recover from rate limits, missing thumbnails, stutter, or shutdown errors | [Troubleshooting](06-troubleshooting.md) |
| Build, test, package, or extend the repository | [Developer and release guide](07-developer-and-release-guide.md) |
| Understand the runtime, schedulers, relays, and security boundaries | [Architecture and runtime reference](08-architecture-and-runtime-reference.md) |

## One-minute quick start

1. Extract the complete portable package, or place `WorldMediaWindows.exe` in
   a writable folder. Do not separate the executable from its companion files
   when using the folder/ZIP build.
2. Double-click the EXE. Microsoft Edge WebView2 Runtime and internet access
   are required. The app opens a native window and starts a localhost service
   bound to `127.0.0.1`.
3. Open **Library**. The first browse starts one independent catalog lane per
   enabled source. Cards and source counts appear as each lane returns data.
4. Search, choose a source/type in the sidebar, or open **Favorites**. Click a
   card to open its detail panel and begin playback.
5. Use the bottom player bar to play/pause, stop, seek finite media, mute, set
   volume, favorite the current item, open EQ, and download or record when the
   source supports that action. The bar also shows the song a radio station is
   playing, when the station sends it, and a small sound meter beside EQ.
6. Use the gear for appearance, content, recorder, quality, source toggles,
   server-port handoff, FFmpeg, downloads, and cache controls.
7. Bring your own channels with **Library → My Playlists → Add link / Import playlist**.
   In Favorites, press All, Radio, TV, Audio, or Video, search your saved items,
   sort them **My order** or **A-Z** (drag cards to reorder them in **My
   order**), and group them in your own categories.
8. Open **Settings → Storage** to back up your data with **Back up my data** or
   to open the folder for your own station pictures.

## What the screens mean

- **Library** is the accumulating, searchable catalog. It keeps collected item
  identities in memory for the session; only the number of mounted DOM cards is
  limited for performance.
- **Tuner** puts the live radio or TV dial beside a station list. Turn the
  dial with the wheel or scroll the list to browse it. **Stations** and
  **Tone knobs** show or hide the list and knobs. The TV picture sits above
  the list, and **Visualizer:** sets the background strength.
- **Computer** browses music, films, shows and audiobooks in folders you add.
  Search, star your files and pick up an audiobook where you stopped.
- **Now Playing** shows what is playing. Turn on **Surprise me** for a random
  pick from your enabled sources.
- **Visualizer** shows pictures that move with the sound of whatever is
  playing. It loads when you open the tab or turn on the Tuner background
  during playback.
- **About** explains the public sources, privacy model, licenses, and bundled
  runtime notices, and credits the code the Visualizer borrows.

## Screenshots in this repository

These screenshots show the main views and settings.

- [All Sources](<../../screenshots/v0.1.14/library.png>)
- [Favorites with categories and a station's details](<../../screenshots/v0.1.14/favorites.png>)
- [My Playlists and Add link](<../../screenshots/v0.1.14/my-playlists.png>)
- [Video in the larger player](<../../screenshots/v0.1.14/video.png>)
- [Tuner with the radio dial, tone knobs and station list](<../../screenshots/v0.1.14/tuner.png>)
- [Tuner with a TV channel playing above the station list](<../../screenshots/v0.1.14/tuner-tv.png>)
- [Picture panel with Fit and Quality](<../../screenshots/v0.1.14/picture-panel.png>)
- [Now Playing](<../../screenshots/v0.1.14/now-playing.png>)
- [Equalizer](<../../screenshots/v0.1.14/equalizer.png>)
- [Song log](<../../screenshots/v0.1.14/song-log.png>)
- [Settings](<../../screenshots/v0.1.14/settings.png>)
- [Visualizer settings panel: Effects](<../../screenshots/v0.1.14/visualizer-panel.png>)
- [Visualizer settings panel: Overlays](<../../screenshots/v0.1.14/visualizer-overlays.png>)
- [Visualizer: Black Hole](<../../screenshots/v0.1.14/visualizer-black-hole.jpg>)
- [Visualizer: Synthwave Grid](<../../screenshots/v0.1.14/visualizer-synthwave.jpg>)
- [Visualizer: Kleinian Group](<../../screenshots/v0.1.14/visualizer-kleinian.jpg>)
- [Visualizer: Hyperbolic Tiling](<../../screenshots/v0.1.14/visualizer-hyperbolic.jpg>)
- [Visualizer: Mandelbrot Deep with Stained Glass](<../../screenshots/v0.1.14/visualizer-stained-glass.jpg>)
- [Visualizer: Flow Field with Oil Paint](<../../screenshots/v0.1.14/visualizer-flow-field.jpg>)
- [Visualizer: Physarum](<../../screenshots/v0.1.14/visualizer-physarum.jpg>)
- [Visualizer: Aurora](<../../screenshots/v0.1.14/visualizer-aurora.jpg>)
- [Theme: Midnight · Blue](<../../screenshots/v0.1.14/theme-midnight.png>)
- [Theme: Forest · Green](<../../screenshots/v0.1.14/theme-forest.png>)
- [Theme: Ember · Orange](<../../screenshots/v0.1.14/theme-ember.png>)

Short GIF demos:

- [The Tuner dial moving beside the station list, with tone knobs below](<../../screenshots/v0.1.14/demo-tuner.gif>)
- [Now Playing with the sound meter](../../screenshots/v0.1.14/demo-now-playing.gif)
- [The Visualizer](../../screenshots/v0.1.14/demo-visualizer.gif)

Screenshots show a point-in-time provider result. Counts, logos, stream
availability, and status labels are live data and will not necessarily match a
later launch.

## Important operational truths

- There is no application cap that stops a Library source at 300 or 6,000
  items. The Library keeps the complete session catalog; `300` is the maximum
  number of cards mounted in one render window. Use **Show earlier items** and
  the normal scroll sentinel to move through a larger session.
- All enabled sources are scheduled through a shared fair queue, with one
  provider lane per source by default and stricter policies for providers that
  request pacing. A rate-limited or failed source retains its cursor and retries;
  it is not falsely marked complete.
- Playing media deliberately receives network/CPU priority. Catalog and
  artwork work continues at a reduced background rate, and returns to normal
  when playback stops. This is why thumbnails can arrive more slowly while a
  stream is active.
- A live stream is always an upstream dependency. The app can rotate through
  known candidates and recover HLS/DASH sessions, but it cannot make an offline
  broadcaster reliable.
- Favorites, settings, EQ curves, job history, cache records, logs, downloads,
  and optional FFmpeg tools have different storage locations. See [Data,
  cache, and portability](05-data-cache-and-portability.md) before moving or
  cleaning an installation.

## Related repository documents

The wiki is the user-facing guide. The original engineering records remain
useful for implementation detail:

- [Provider endpoint and cache contract](../PROVIDERS.md)
- [Windows build guide](../BUILD_WINDOWS.md)
- [Repository file tree](../FILE_TREE.md)
- [Release checklist](../RELEASE_CHECKLIST.md)
