# Open Media Explorer — User Wiki

This is the end-to-end guide for the Windows-native World Media application.
It describes the shipped `0.1.2` behavior in this repository: how to
install and run it, browse all eleven public sources, play media, use the
equalizer, download finite files, record live streams, preserve portable data,
and diagnose provider or runtime problems.

The app is a local desktop shell around public catalogs. It does not host the
catalogs or stream files itself, and it does not have a fixed channel list.
Stations, channels, episodes, and archive records are discovered from the
providers at run time and can change without an app update.

![World Media Library with all eleven public sources](<../../screenshots/updated screenshots/all_sources.PNG>)

| Tune live radio and TV | Discover something unexpected |
|---|---|
| ![World Media Tuner](<../../screenshots/updated screenshots/tuner.PNG>) | ![World Media Discovery](<../../screenshots/updated screenshots/discovery.PNG>) |

![Ten-band equalizer with automatic presets](<../../screenshots/updated screenshots/eq.PNG>)

## Start here

| If you want to… | Read |
|---|---|
| Install the EXE or move it to another drive | [Installation and portable data](01-installation-and-portable-data.md) |
| Learn the five tabs, sidebar, filters, and settings | [Using the application](02-using-the-application.md) |
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
   source supports that action.
6. Use the gear for appearance, content, recorder, quality, source toggles,
   server-port handoff, FFmpeg, downloads, and cache controls.

## What the screens mean

- **Library** is the accumulating, searchable catalog. It keeps collected item
  identities in memory for the session; only the number of mounted DOM cards is
  limited for performance.
- **Tuner** is a live station/channel selector with a rotary presentation.
  Frequencies are a convenient UI index, not broadcaster frequencies.
- **Grid** is a guide-style view for live TV and radio. It uses the same live
  adapters as Tuner but presents tiles, category/country/source filters, and a
  text filter.
- **Discovery** asks enabled sources for bounded random candidates and returns
  one result at a time. It does not try to download every catalog first.
- **About** explains the public sources, privacy model, licenses, and bundled
  runtime notices.

## Screenshots in this repository

These are reference captures of the current UI. They are linked rather than
copied so the wiki stays alongside the source screenshots:

- [All Sources](<../../screenshots/updated screenshots/all_sources.PNG>)
- [Favorites](<../../screenshots/updated screenshots/favorites.PNG>)
- [Radio detail and playback](<../../screenshots/updated screenshots/radio.PNG>)
- [Radio playing](<../../screenshots/updated screenshots/radio_playing.PNG>)
- [Radio Browser source](<../../screenshots/updated screenshots/radio_browser.PNG>)
- [TV detail and playback](<../../screenshots/updated screenshots/tv.PNG>)
- [Grid](<../../screenshots/updated screenshots/grid.PNG>)
- [Tuner](<../../screenshots/updated screenshots/tuner.PNG>)
- [Discovery](<../../screenshots/updated screenshots/discovery.PNG>)
- [Equalizer](<../../screenshots/updated screenshots/eq.PNG>)
- [Large video player](<../../screenshots/updated screenshots/big_tv_player.PNG>)

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
- [Five-source research notes](../FIVE_NEW_SOURCES_RESEARCH.md)
- [Player/capture/EQ research notes](../PLAYER_CAPTURE_EQ_RESEARCH.md)
