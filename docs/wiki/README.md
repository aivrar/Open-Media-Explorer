# Open Media Explorer — User Wiki

This is the end-to-end guide for the Windows-native World Media application.
It describes the shipped `0.1.15` behavior in this repository: how to
install and run it, browse all ten public sources, play media, use the
equalizer, watch the Visualizer, download finite files, record live streams,
preserve portable data, and diagnose provider or runtime problems.

The app is a local desktop shell around public catalogs. It does not host the
catalogs or stream files itself, and it does not have a fixed channel list.
Stations, channels, episodes, and archive records are discovered from the
providers at run time and can change without an app update.

![World Media Library with its public sources](<../../screenshots/v0.1.14/library.png>)

| Tune live radio and TV | Discover something unexpected |
|---|---|
| ![World Media Tuner](<../../screenshots/v0.1.14/tuner.png>) | ![World Media Discovery](<../../screenshots/v0.1.14/discovery.png>) |

![Ten-band equalizer with presets](<../../screenshots/v0.1.14/equalizer.png>)

![Visualizer - Black Hole with Lasers and Tron Hex Grid](<../../screenshots/v0.1.14/visualizer-black-hole.jpg>)

## New in 0.1.15

- Radio Browser stations load much faster: the Library asks for 300 at a time
  where it asked for 30. Lists are sent compressed. See [Sources and
  channels](03-sources-and-channels.md#provider-pacing-and-caching).
- A server with several addresses, one of them dead or slow, no longer holds a
  stream or a list up: the app tries the addresses together. See [Architecture
  and runtime
  reference](08-architecture-and-runtime-reference.md#playback-and-relay-boundary).
- After the connection drops, sources that failed are asked again by
  themselves when it comes back, in the Library, the Tuner and the Grid. See
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

- **Now Playing:** a new tab between **Discovery** and **Visualizer** shows what
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
  default) draws light scenes faintly behind the Tuner while sound plays. See
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
  a notice about photosensitivity comes first. Work on it continues. See
  [Visualizer](09-visualizer.md).
- Importing a playlist now starts on **Add as: Auto**, which works out radio or
  TV by itself, and the import result says what it chose when some channels
  needed a type from **Add as**. Importing the same playlist again as Radio
  moves its TV favorites over (and the other way round). The Tuner's status
  line says when some of your favorites are saved as the other type. See [Using
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
- **Settings > Appearance > Tuner card size** makes the station cards under the
  Tuner dial Medium or Large, with each station's picture. The knob shows only
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
| Learn the seven tabs, sidebar, filters, and settings | [Using the application](02-using-the-application.md) |
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
- **Tuner** is a live station/channel selector with a rotary presentation.
  The dial shows the station's place in the list, not a broadcast frequency,
  and can be limited to your starred stations or one of your categories. Its
  station cards come in three sizes; Medium and Large show station pictures.
- **Grid** is a guide-style view for live TV and radio. It uses the same live
  adapters as Tuner but presents tiles, category/country/source filters, and a
  text filter.
- **Discovery** asks enabled sources for bounded random candidates and returns
  one result at a time. It does not try to download every catalog first.
- **Visualizer** shows pictures that move with the sound of whatever is
  playing. It loads only when you open it and costs nothing while its tab is
  closed.
- **About** explains the public sources, privacy model, licenses, and bundled
  runtime notices, and credits the code the Visualizer borrows.

## Screenshots in this repository

These are reference captures of the current UI. They are linked rather than
copied so the wiki stays alongside the source screenshots:

- [All Sources](<../../screenshots/v0.1.14/library.png>)
- [Favorites with categories and a station's details](<../../screenshots/v0.1.14/favorites.png>)
- [My Playlists and Add link](<../../screenshots/v0.1.14/my-playlists.png>)
- [Video in the larger player](<../../screenshots/v0.1.14/video.png>)
- [Tuner with the Visualizer behind it](<../../screenshots/v0.1.14/tuner.png>)
- [Grid](<../../screenshots/v0.1.14/grid.png>)
- [Discovery](<../../screenshots/v0.1.14/discovery.png>)
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
- [Theme: Amethyst · Violet](<../../screenshots/v0.1.14/theme-amethyst.png>)

Short GIF demos:

- [A short tour of the tabs](../../screenshots/v0.1.14/demo-tour.gif)
- [The Tuner dial](../../screenshots/v0.1.14/demo-tuner.gif)
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
