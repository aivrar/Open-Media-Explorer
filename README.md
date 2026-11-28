# Open Media Explorer

[![Latest release](https://img.shields.io/github/v/release/aivrar/Open-Media-Explorer?display_name=tag&sort=semver)](https://github.com/aivrar/Open-Media-Explorer/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2022H2%2F11-0078D4)
![Portable](https://img.shields.io/badge/portable-single%20EXE-2ea44f)
![Sources](https://img.shields.io/badge/public%20sources-10-F28C52)
![Privacy](https://img.shields.io/badge/accounts%20%7C%20telemetry-none-success)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)

**Explore the world's open media from one portable Windows app.** World Media
brings together internet radio, live television, podcasts, public-domain films,
space media, cultural archives, audiobooks, conference recordings, PeerTube,
and independent Owncast streams from ten public sources.

Search online sources and files on your computer, save favorites, tune live
radio and TV, and try a random pick in Now Playing. Watch the Visualizer move
with the sound, shape playback with a ten-band EQ, download finite media, and
optionally record live streams. No account, subscription, API key, or telemetry.

**New in v0.1.19:** the **Computer** tab plays music, films, shows and
audiobooks from folders you add. Browse, search and star your files, choose a
film's subtitles and sound track, or even out the loudness of your music.
Library search also finds your files. Turn on **Surprise me** in **Now
Playing** to play a random pick.

**In v0.1.18:** tune radio and TV with a station list beside the dial and
optional **Bass**, **Treble** and **Loudness** knobs. TV keeps its picture above
the list, and the **Picture** panel can choose a video quality level. The
Visualizer can show behind the Tuner during TV and video. The player bar fits
narrow windows better, picture drops highlight the target card, and Favorites
scroll as you drag near an edge. Video controls have lighter shading, channel
changes keep your place in the list, and **Pick the best stream** explains
each choice. Thanks to TaxicabMessiah for the reports.
[Discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8) ·
[Issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)

**New in v0.1.16:** a station's stream format and bitrate now show for stations
from any source once they have played, not only for those Radio Browser lists:
the app remembers what the station's own stream said and shows it in the
station's tooltip ("Stream: AAC+ · 320 kbps"), in its details and, with **Show
technical source details** on, on its card. Some live AAC stations on Shoutcast
servers failed to start about one time in five or six; such a stream now starts
at its first whole sound frame. The volume slider is replaced by a compact
control (up, a number, down), and the player bar gained a one-row layout.
The Tuner gained one-station wheel steps and a **Visualizer:** control to
set the background strength. Starting the app again while it runs brings
its open window to the front instead of opening a second one. The missing
stream details were reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

**New in v0.1.15:** channels, stations and episodes load faster and keep
loading through a poor connection: Radio Browser stations arrive 300 at a time,
lists are sent compressed, a server with a dead or slow address no longer holds
things up, and sources that failed are asked again by themselves when the
connection comes back. Podcast episodes published as M4A, Ogg, Opus, FLAC, WAV
or WebM are now listed and play, and so are more media.ccc.de, Wikimedia
Commons and Internet Archive recordings. Owncast and the media.ccc.de live
rooms are listed from the start, whichever Library view is open.

**New in v0.1.14:** stations on an old Shoutcast server, which did not play
although their address worked in a browser, now play, with their song titles.
Reported in [issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

**New in v0.1.13:** a **Now Playing** tab shows the station, the song and the
stream details large, over a blurred copy of its picture, with a large sound
meter. Live radio and TV no longer show a seek bar, the song on the player bar
is larger, a small red **!** marks a station that did not play last time, and
a station can get a picture from a file or by dropping one on its card. The
Visualizer has 103 scenes, three new overlays, two new blends and an **Extra
glow** switch, and can be shown faintly behind the Tuner. Dragging Favorites
into order is fixed. Reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)
and requested in [discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

**New in v0.1.12:** star the songs you like, give a station a name of your
own, drag Favorites into order, import `.json` and `.csv` playlists, and let
the app pick a station's best stream. A **Processor use** setting lets the
Visualizer use more of the computer, and the Visualizer now has 99 scenes, a
Strobe overlay and a side panel that folds into clear sections. A live
station whose connection closes now reconnects. Reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)
and requested in [discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

**New in v0.1.11:** a **Visualizer** tab shows pictures that move with the
sound of what is playing (71 scenes, effects, overlays and a shuffle). It shows
moving, flashing pictures, so a photosensitivity notice comes first. Importing
a playlist starts on **Add as: Auto**, which works out radio or TV by itself,
and Favorites get **Move to bottom** and **Remove all favorites**. Reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)
and requested in [discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

**New in v0.1.10:** a small sound meter in the player bar shows that a station
is really playing, the Tuner's station cards come in three sizes (Medium and
Large show station pictures), and the knob shows only the station's name.
Fixes: your own station pictures are no longer cut off, and the Tuner dial
keeps its size. Reported in [issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6)
and requested in [discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

**New in v0.1.9:** sort Favorites by hand or A-Z and group them in categories,
import `.pls` and `.xspf` playlists, see the song a radio station plays (with a
song log), use your own station pictures, and back up your data with one
button. Live streams reconnect by themselves. Library of Congress is gone (its
site refuses apps). Requested in [discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

**New in v0.1.8:** Tuner dial fixes. A dial with one station stays put, the
knob always rests at the same angle for the same station, the dial is no longer
cut off in a short window, and playing items without artwork show initials in
the player bar.

**New in v0.1.7:** drop an `.m3u` playlist file anywhere on the window to
import it, radio stations that stream without a picture no longer open an empty
video square, and the Tuner gained a way to keep the current station in view.

**New in v0.1.6:** sources you switch off in Settings disappear from the
Library sidebar, the mouse wheel turns the Tuner dial, and the floating video
grows with the window and has a button for a larger size. The optional FFmpeg
install in Settings works again after its provider moved on GitHub.

**New in v0.1.5:** the portable ZIP opens its window again after being
extracted from a download (it failed to start in v0.1.2 to v0.1.4).

**New in v0.1.4:** your favorites come first. The Library opens on
**Favorites**, saved items use compact cards, and the Tuner can spin through
only your starred stations with **★ My favorites**. The Tuner shows stations
as each source answers, more station logos load, items without artwork show
their initials, and the source labels are simpler (a Settings switch brings the
technical details back).

[**Download the latest EXE**](https://github.com/aivrar/Open-Media-Explorer/releases/latest/download/WorldMediaWindows.exe)
· [Full documentation](docs/wiki/README.md)
· [Release history](https://github.com/aivrar/Open-Media-Explorer/releases)

![Open Media Explorer - Library view](screenshots/v0.1.14/library.png)

![World Media Tuner with the radio dial, tone knobs and station list](screenshots/v0.1.14/tuner.png)

![Ten-band equalizer with presets](screenshots/v0.1.14/equalizer.png)

## Install

For the classic one-file Windows app, download and run:

```text
WorldMediaWindows.exe
```

The executable is unsigned and some heuristic antivirus products may require
the file or its containing folder to be explicitly allowed. The alternative
signed-runtime portable package is:

```text
WorldMediaWindows-0.1.19-portable.zip
```

For that package, extract the entire archive, keep its files together, and run
`WorldMediaWindows.exe` inside the `WorldMediaWindows` folder. Either form starts
a local server on `127.0.0.1`, opens a native WebView2
window, and stores its cache, favorites profile, settings, and logs beside the
launcher under:

```text
WorldMediaWindows-data\
```

An existing `%LOCALAPPDATA%\WorldMediaWindows\webview2_data` profile is copied
there once to preserve favorites; the legacy source is not deleted automatically.
The classic single EXE uses the Windows temporary directory only for its
transient startup extraction and cleans its `_MEI...` directory on normal
shutdown. Persistent app data always remains beside the EXE.

Only one copy runs per data folder. Starting the app again while it runs with
the same `WorldMediaWindows-data` folder brings the open window to the front
(restored if it was minimized) and does not open a second window. Copies with
different data folders, such as two portable folders, run side by side.

Users do not need Python, Node, Rust, Git, Docker, or WSL.

## Documentation

The full end-to-end user and developer wiki is in
[docs/wiki/README.md](docs/wiki/README.md), with a short index at
[docs/WIKI.md](docs/WIKI.md).

## What You Get

The tabs are **Library**, **Tuner**, **Computer**, **Now Playing**,
**Visualizer** and **About**. Library opens if a saved start tab has been removed.
Right-click a text field for **Undo**, **Cut**, **Copy**, **Paste** and
**Select all**.

**Library** - search and browse everything. Left sidebar groups results by type
and source: Radio Browser, iptv-org, Internet Archive, NASA, Wikimedia Commons,
LibriVox, media.ccc.de/C3VOC, gPodder Podcasts, PeerTube, and Owncast.
Use the live radio and TV filters to browse stations. Search also finds your
own files and labels them **Computer**. Use **Audio** or **Video** to narrow
the results. The count beside the filters shows how many results match,
with "so far" while sources load. Clear what you typed in Search,
Country or Language to return to where you were. The Language box accepts
codes and names such as `en`, `eng` and `English`, including for iptv-org TV.
Clicking a card opens its details and keeps the card in place.

![Library - Favorites in categories, with a station's details open](screenshots/v0.1.14/favorites.png)

**Tuner** - a radio-style dial on the left and a station list on the right.
Drag the dial or turn the mouse wheel over it. Each notch moves one station
and wraps at the ends. The wheel over the list scrolls it. With the dial focused, use the arrow keys
to move and Enter or Space to play. The dial shows the station's place
("12 of 80") and fits the name on one or two lines. Click a list entry to
play it, or use the arrow keys to move and Enter to play. The list keeps the
selected station highlighted and in view. Clicking a station already in view
leaves the list in place. Entries show the source and, where known, the
country and radio stream format and bitrate. Wide lists use two
columns, and a count sits below the list.

Pick **★ My favorites** or a category in **Source** to use your Favorites
order. **Settings > Appearance > Tuner card size** sets the row size. Medium
and Large also show pictures. Use **Stations** and **Tone knobs** in the top
bar to show or hide the list and the knobs. Both choices are remembered. The
**Bass**, **Treble** and **Loudness** knobs sit below the dial and show their
dB value on hover, for example "Bass · main EQ · +2 dB".

The TV picture sits above the list. While a channel loads or after **Stop**,
its art or initials, name and **Loading…** or **Stopped** hold the picture's
place. The dial and knobs stay in the same place when you switch bands with
the list shown. Hide the list for a larger, centered Radio dial or a larger
TV picture beside the dial.

The **Visualizer:** control sets the strength of the background during
music, TV or video playback after you accept the flashing notice. The
default strength is 8. Set it to 0 to turn **Show the Visualizer behind the
Tuner** off.

![Tuner - the dial moving from station to station beside the list, with tone knobs below](screenshots/v0.1.14/demo-tuner.gif)

![Tuner - a TV channel playing above the station list, beside the dial and tone knobs](screenshots/v0.1.14/tuner-tv.png)

**Computer** - play music, films, shows and audiobooks from your own folders.
Use **Add folder...** to add up to 200 folders. The app includes their
subfolders. You can search, sort, use **Play all** or **Shuffle**, and step
through the queue with **Previous** and **Next**.

- **Music** opens **Albums**, **Artists**, **Songs**, **Genres** and **Folders**.
  Covers can come from the music files or the folder. The app prepares the
  next song of an album so it can start as the current one ends.
- **Videos** opens **Movies**, **Shows**, **All videos** and **Folders**.
  Movies have posters and a details panel. Shows group episodes by season.
- **Audiobooks** lists chapters when available and remembers where you stopped.
- **Favorites** shows files you starred. Use the star or press **F** on a
  song, album, artist, film or show. Starred files also appear in
  **Library > Favorites**.

MP3, AAC / M4A, FLAC, PCM WAV, Ogg Vorbis and Opus play directly when the
player supports the file. FFmpeg converts other formats for playback with
seeking. Examples include AIFF, ALAC, APE, WavPack, DSD, WMA, AC-3 and DTS
for sound, and MPEG-2 / DVD VOB, AVI, WMV, HEVC and other MKV or MP4 variants
for video. Video conversion uses the graphics card's encoder when available.
For DVD VOB files with restarting timestamps, the app can rebuild the
timeline for the true length and exact seeking. Use an existing capable
FFmpeg pair or confirm the install in Settings.

Open **Subtitles** in the player bar. Press **C** to turn subtitles on or
off. The app reads .srt, .vtt and .ass files beside the film or in a
**Subs** folder, and text subtitles inside the film. Picture-based DVD and
Blu-ray subtitles are unavailable.
Use **Audio** to switch sound tracks, such as stereo, 5.1, another language or
commentary. The app remembers track choices per film and by language.

The app handles large collections (tested with 50,000 files). A scan reuses
what it read from unchanged files. If a drive is disconnected, its folders
stay in the list. Use **Locate...** to point to a new location, for example
after a drive letter change. Stars follow moved or renamed files when the
app can match them. Hide the tab under **Settings > Appearance > Tabs shown**.

**Library detail panel** - click any item to see metadata, license, source, and
play it.

![Library - detail panel with a NASA video in the larger player](screenshots/v0.1.14/video.png)

**Now Playing** - whatever plays now, shown large: the station or item picture
over a blurred copy of it, its name, the song a radio station announces (with
a star and **Copy**), the stream details, how long it has played, and a large
sound meter. The meter turns red and reads **Muted** when muted. The **Format**
row also shows remembered details for playlist stations and HLS streams.
Turn on **Surprise me** to play a random pick from your enabled sources.

![Now Playing - station picture, song and the large sound meter](screenshots/v0.1.14/now-playing.png)

**Visualizer** - pictures that move with the sound of whatever is playing. It
has 103 scenes (flat patterns, 3D scenes, simulations and line drawings), a
**Look** choice for the scenes that have ready-made looks, a scene shuffle you
can limit to **Light only**, **Light and medium**, or all scenes (heavy too),
post effects and overlays (off until you turn them on), a slow drift in time
with the music, a star that keeps a scene with its effects and overlays, and a
quality, frame rate and brightness choice. Shuffle listens for builds, drops
and breaks, and scenes dissolve into one another. **Color travel** lets the
palette drift with the music. DIFS Tunnel Flight is brighter. Its side panel folds into sections
that say what is set. When the computer cannot keep up it lowers the load by
itself, and **Settings > Processor use** can let it use more of the processor
for a finer picture. It runs while its tab is open, or behind the Tuner if
you turn that setting on. It leaves the sound unchanged. It shows moving, flashing pictures: a notice about
photosensitivity comes before the first picture, and a flash limiter is always
on. See the
[Visualizer page](docs/wiki/09-visualizer.md).

![The Visualizer moving with the music: four scenes with effects and overlays](screenshots/v0.1.14/demo-visualizer.gif)

| | |
|---|---|
| ![Visualizer - Black Hole with Lasers and Tron Hex Grid](screenshots/v0.1.14/visualizer-black-hole.jpg) | ![Visualizer - Synthwave Grid with Matrix Rain and Neon Frame](screenshots/v0.1.14/visualizer-synthwave.jpg) |
| ![Visualizer - Kleinian Group with Sacred Geometry](screenshots/v0.1.14/visualizer-kleinian.jpg) | ![Visualizer - Hyperbolic Tiling with Starburst and Dot Spiral](screenshots/v0.1.14/visualizer-hyperbolic.jpg) |
| ![Visualizer - Mandelbrot Deep with the Stained Glass effect](screenshots/v0.1.14/visualizer-stained-glass.jpg) | ![Visualizer - Flow Field with the Oil Paint effect](screenshots/v0.1.14/visualizer-flow-field.jpg) |
| ![Visualizer - Physarum with Lasers and Neon Frame](screenshots/v0.1.14/visualizer-physarum.jpg) | ![Visualizer - Aurora with Sacred Geometry and Dot Spiral](screenshots/v0.1.14/visualizer-aurora.jpg) |

![Visualizer - the settings panel with the Effects list](screenshots/v0.1.14/visualizer-panel.png)

Library discovery collects concurrently from enabled sources, with independent
provider pacing and backoff. There is no fixed total-item cap. Only 300 cards
are mounted at a time to keep scrolling responsive; collected items are kept.
Compact sidebar statuses and hover details distinguish pulling, rate limits,
stale snapshots, and completed catalogs. Playback gets priority over background
collection and artwork; normal background priority returns when playback stops.

### Your own channels and organized Favorites

Open **Library → My Playlists → Add link**, paste a stream URL, optionally
name it, and press **Add**. Choose **Online playlist** for a channel-list
URL, or use **Import playlist** for a local `.m3u`, `.m3u8`, `.pls`, `.xspf`,
`.json` or `.csv` file. You can also drop a local playlist file anywhere on
the window. A playlist that points to a web channel list can import its
channels. The app follows up to four links, one level deep, and imports up
to 5,000 channels. A link that fails to load stays as one entry and the import
message says so. A direct HLS `.m3u8` stream belongs under **Single channel**.
Importing the same link again updates the saved Library collection.
**Add as** (Auto, TV or Radio) gives a type to channels that do not say whether
they are radio or TV. Auto, the default, uses what most channels in the same
file say. When some channels needed a type from **Add as**, the result tells
you how many, and with Auto what it chose. To change or remove stations,
edit your own playlist file and import it again under the same file name, or
press **Remove playlist** to remove the list. Use **Stream address...** in a
saved station's details to change its HTTP or HTTPS address and add up to
five backups. Press **Up** on the first backup to make it the main address.
Stream format and quality stay saved until the main address changes. World
Media tries the backups in order if the main address fails to start, and on
reconnect.

In **Favorites** and **My Playlists**, use the **All / Radio / TV / Audio /
Video** buttons and local search to find saved channels. **Star all** in My
Playlists adds every listed channel to Favorites. Removing a playlist keeps its
favorites. **Export...** saves the items shown, using the selected type,
playlist or category, and search. Choose **M3U8** or **JSON**. The file goes
into Downloads and can be imported again with custom names and edited and
backup addresses. The message counts items skipped for lack of a stream
address. Each export creates a new file. Playlist URLs may contain access
tokens, so keep your data folder private.

Favorites can be sorted **My order** (drag a card before or after another, or
move it up, down, to the top or to the bottom with the buttons on it) or
**A-Z**. In **My order**, drag near the top or bottom edge to scroll the list.
Use the tag button on a favorite card to put it in a category of your
own, such as "Rock" or "Talk", and the category buttons above the list to show
one category. **Rename** in a favorite's details gives it a name of your own;
**Use original name** brings the station's name back. **Remove all
favorites** asks first and says how many it will remove.

![My Playlists and the Add link form, shown with public sample channels](screenshots/v0.1.14/my-playlists.png)

### Song titles, station pictures, and backup

Many radio stations announce the song they are playing. When a station does,
the title shows under the station name in the player bar, and the note button
at the top right opens a **Song log** of the songs you heard, which you can
copy or save as a CSV file. Star a song in the log, or the one playing now
with the star on the player bar, to keep it under **Starred songs**, where it
can be looked up on the web or on YouTube or saved as a text or CSV file. Not
every station sends titles, and stations delivered as HLS do not show one.
In **Favorites**, turn on **Show what's playing** to see the song on the first
line and performer on the second when a radio station sends both. Point at
the title for the station's original text. Titles refresh while Favorites is
open and the window is visible. The button is off by default.

![Song log with starred songs](screenshots/v0.1.14/song-log.png)

Put a picture named exactly like a station (PNG, JPG, WebP or GIF, up to 2 MB)
in the `station-images` folder (**Settings → Station images → Open folder**),
press **Refresh**, and it replaces that station's artwork, shown whole and
never cut off. A name Windows cannot use in a file, such as the "/" in
"AC/DC Radio", is written with `-`, `_`, a space or nothing in its place.
Settings lists the pictures that were not used and why. You can also drop a
picture on a card in **Favorites** or **My Playlists**. A picture you set
belongs to that station, even if another station has the same name. The card
under the pointer shows "Drop to set this station's picture". The picture
appears with **Saving…** and the previous picture returns if saving fails.
A refusal clears after 6 seconds, or 8 for longer messages. Press Escape,
click or start another drag to clear it sooner.

A station's format and
bitrate (for example "AAC+ · 320 kbps") show in its detail panel, in the tooltip
of its card in the Library and the Tuner, and on its card with **Show technical
source details** on. Radio Browser lists them for its stations; any other
station shows them once it has played, including HLS. Video can also show
resolution, frame rate and codec, for example "Stream: HLS · 1080p · 50 fps
· H.264 · 6.22 Mbps". **Clear local cache** removes remembered stream details. **Other streams** lists other listings of the same Radio Browser
station to pick from by hand.
**Settings > Content > Pick the best stream** explains the three choices.
**Off** tries the first two listed streams together and plays whichever
answers first. **Listed streams** starts with the best listed stream and
tries the next if it fails or is slow to start. **Auto (verified)** also checks
other radio directory entries and can use a better stream on a later start
if both streams match on two different songs.

**Settings → Storage → Back up my data** writes one ZIP into the `downloads`
folder with your favorites and the names you gave them, settings, categories,
song log, starred songs, imported playlists, station pictures, saved video
picture settings and edited and backup stream addresses, plus `.m3u8` playlist
files that other players can open.
There is no restore button; the
[data guide](docs/wiki/05-data-cache-and-portability.md) says how to copy it
back. Playlist addresses can contain private links or account tokens, so share
the ZIP only with people you trust.

### Updating without losing data

Shut down the app, back up `WorldMediaWindows-data`, and replace only the EXE
for a single-file update. Keep the same adjacent data folder, downloads, and
tools. For ZIP updates, extract the new package separately and copy your backed-up
data, downloads, and tools beside its launcher. Never overwrite your profile
with a fresh test profile. See the [portability guide](docs/wiki/05-data-cache-and-portability.md).

## Appearance

Settings includes **System**, **Dark · Teal**, **Light**, **Midnight · Blue**,
**Forest · Green**, **Ember · Orange**, and **Amethyst · Violet**. Changes apply
immediately and persist across launches. System follows the Windows light/dark
preference. **Settings > Appearance > Tabs shown** hides tabs you do not use.
Library is always visible. **Now Playing background blur** offers **Off**,
**Light**, **Medium** (the default) and **Strong**. Sources switched off in **Settings > Sources**
appear dimmed at the bottom of the Library sidebar. Turning a source back on
runs the current search for it again.

| Midnight · Blue | Forest · Green | Ember · Orange |
|---|---|---|
| ![Midnight theme - Now Playing](screenshots/v0.1.14/theme-midnight.png) | ![Forest theme - Favorites](screenshots/v0.1.14/theme-forest.png) | ![Ember theme - Tuner](screenshots/v0.1.14/theme-ember.png) |

![Settings - Appearance](screenshots/v0.1.14/settings.png)

The native title bar follows the selected theme too. Windows 11 supports the
exact palette color; Windows 10 uses the matching dark or light caption style.

## Playback

**Settings > Playback > Volume levelling** offers **Off**, **Track** and
**Album** for music from Computer. Track evens out songs. Album keeps the
loudness differences between songs on the same album. Set **Pre-amp** to
adjust the level when levelling is on. The app uses ReplayGain tags or
measures untagged songs in the background, one song ahead.

Video plays in a movable overlay with fullscreen support. In the Tuner's TV
band, it sits beside the dial. Library, About and Now Playing leave
room to scroll past the picture. They keep that space while another video
starts. They release it on Stop, a failed start or a switch to an item
without a picture.

Open **Picture** beside **EQ** to adjust **Brightness**, **Contrast**,
**Saturation** and **Hue**, or use **Reset**. **Fit** offers **Whole picture**,
**Fill**, **Zoom 110%**, **Zoom 125%** and **Zoom 133%** for black bars.
It applies in fullscreen too.
When the stream offers at least two levels, **Quality** under **Fit** offers
**Auto** (the default), **Best available** or a fixed level such as
**1080p · 5.86 Mbps**. For a level with no stated resolution, the menu shows
the bitrate. **Now 720p** shows the playing resolution when known. **Auto**
adjusts to the picture size and the connection, including in fullscreen.
It replaces buffered lower-quality video when stepping up. If a fixed level
fails, the player returns to **Auto** for the session.

Choose **For this channel** or **For all video**. Channel settings stay
saved while the channel is in Favorites or My Playlists. Backups include
these settings and **Clear local cache** removes them. Recordings and
downloads use the source stream.

![Picture panel - Fit and Quality controls for a video](screenshots/v0.1.14/picture-panel.png)

Live TV hides the video's own timeline and time numbers. On-demand video
keeps them, and a live stream that turns out to be finite gets them back.
The controls use a short, light shade with shadows behind the icons.
Live radio and TV that lose their connection reconnect by themselves for up
to ten minutes. The player bar says "Connection lost. Retrying..." meanwhile.

Internet Archive audio and LibriVox books with several parts play in order.
The player bar shows **Track N of M** or **Chapter N of M**, with **Previous
part** and **Next part**. Choose a part in the item's details and use
**Download** for that part. When you reopen an item with a saved position,
the player bar offers to resume at that position or **Start over**.

As the window narrows, the player bar shortens the title first. It then hides
the meter and time, reduces **Record** to its icon, and hides the second
**EQ** line before using two rows. The volume has its own control beside the speaker (mute) button: an up button, the volume as a
number from 0 to 100, and a down button. A click changes the volume by 1, a held
button repeats, the mouse wheel over the control changes it by 2 per notch, and
with the control focused the arrow keys change it by 1 (Page Up and Page Down by
10, Home and End set 0 and 100). Changing the volume with a video's own controls
moves the number too. When the **Record** button is unavailable, point at it to
read why. **Record audio**, **Record video** and **Stop recording** take up
the same space. A capture's progress, result or error has room beside the
button, with the full status in its tooltip.

A small LED-style sound meter beside **EQ** moves with the sound, so you can see
that a station is really playing. It only reads the sound, rests while nothing
is heard, and can be switched off in **Settings > Appearance > Sound meter in
the player bar**.

![Now Playing with the sound meter moving](screenshots/v0.1.14/demo-now-playing.gif)

## Download, Record, And Equalize

- Finite originals expose **Download** and are written atomically to the
  `downloads` folder beside `WorldMediaWindows.exe`.
- Live radio and TV expose **Record**. Audio is finalized as MP3; video is
  finalized as H.264/AAC MP4. Recording reads the live source independently,
  so pausing, muting, changing volume, or adjusting EQ does not pause or alter
  the saved file. **Stop recording** performs finalization before publishing the
  completed filename.
- Settings provides Compact (96 kbps/480p), Balanced (160 kbps/720p), and High
  (256 kbps/1080p) profiles.
- The ten-band EQ and preamp apply immediately. A favorite can keep its own
  curve. Use **Stations...** to assign or clear a preset for several saved
  stations at once. To assign your current curve, first use **Save new preset**.
  In **Advanced**, set each band's Q from 0.25 to 8. Recordings made with EQ
  use those values.

Only download or record media when its source and your local law permit it.
World Media does not remove DRM or grant rights to third-party broadcasts.

## Where The Content Comes From

Every item World Media surfaces comes from one of ten public archives or
directories. The app does not host content and does not require API keys.

| Source | What it provides | Home | Licensing |
|---|---|---|---|
| [Radio Browser](https://www.radio-browser.info) | Internet radio stations | `radio-browser.info` | Stations retain their own broadcast rights |
| [iptv-org](https://iptv-org.github.io) | Free-to-air IPTV channels | `iptv-org.github.io` | Stream operators retain their own rights |
| [Internet Archive](https://archive.org) | Films, recordings, books, and other media | `archive.org` | Per item, often public domain or Creative Commons |
| [NASA Image and Video Library](https://images.nasa.gov) | Mission photos, videos, and audio | `images.nasa.gov` | Public domain for U.S. government work |
| [Wikimedia Commons](https://commons.wikimedia.org) | Free-licensed media files | `commons.wikimedia.org` | CC-BY-SA or public domain per file |
| [LibriVox](https://librivox.org) | Public-domain audiobooks | `librivox.org` | Public domain |
| [media.ccc.de](https://media.ccc.de) | Technical conference recordings and current C3VOC streams | `media.ccc.de` | Per recording or event |
| [gPodder](https://gpodder.net) | Open podcast directory resolved through publisher feeds | `gpodder.net` | Publisher terms per episode |
| [PeerTube](https://joinpeertube.org) | Federated on-demand and live video | Independent instances | Per video and instance |
| [Owncast](https://owncast.online) | Independent self-hosted live video | Independent servers | Broadcaster terms |

## Privacy And Runtime Model

- **No accounts.** Nothing to sign up for.
- **No telemetry.** The app does not collect usage data.
- **No API keys.** All ten sources use public anonymous endpoints.
- **Computer files stay on your computer.** The app reads media from the
  folders you add, including their subfolders. It keeps the folder list,
  library index, stars, thumbnails and conversion caches in the data folder.
  See the [data guide](docs/wiki/05-data-cache-and-portability.md#computer-files).
- **Localhost only.** The bundled Python server binds to `127.0.0.1`.
- **Two bounded same-origin relays.** Catalog metadata uses an HTTPS-only,
  DNS-pinned allowlist proxy. Playback and capture use opaque expiring relay
  IDs, including rewritten HLS and DASH child resources. Upstream URLs and
  required playback headers are not exposed through control routes or logs.
- **No Linux child.** This build has no WSL distro, no rootfs image, no Docker
  image, and no setup script.

## Content Preference And Provider Limits

Explicit/NSFW content is off by default. It can be enabled only with the
**Show explicit/NSFW content** switch in Settings. Marked items are then shown
with a visible label; enabling the switch does not weaken URL, redirect,
private-network, schema, or media-safety checks. Turning it off hides marked
items everywhere while retaining saved favorites as nonrevealing placeholders.

Public catalogs are not equally reliable. A source may return a CAPTCHA or 429
even below its published limit; the app retains the cursor and backs off
instead of reporting a false zero. Podcast feeds and independent
PeerTube/Owncast servers may be dead, slow, or malformed; one failure is
isolated from the other sources. C3VOC and Owncast are live snapshots that
refresh, and an empty C3VOC snapshot between events is valid. A provider marked
**complete** has reached the end of the current finite catalog; live snapshots
continue on their own refresh schedule.

Library of Congress was removed from the app because its site (loc.gov) no
longer answers apps: every request now gets a browser check instead of data,
and World Media does not try to get around that. Items you saved from it stay
in Favorites and playlists.

The exact public endpoints, cache/refresh rules, and source-specific limits are
documented in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Troubleshooting

- If Library says collecting is paused, scroll toward the bottom of the current
  results; fetching resumes automatically. Use **Load more** for an immediate
  user-priority request.
- **Retrying**, **rate limited**, or **stale** means the cursor and last verified
  data were preserved. **Retry now** is safe and does not create duplicate work.
- A playable item can still lack Download when the provider restricts it or
  exposes only a stream. Live media uses Record after a capable FFmpeg pair is
  detected or installed from Settings.
- An empty or broken independent stream is an upstream condition. **Try next**
  moves on without deleting the item or favorite.
- No song title under a station means the station does not send one (or is
  delivered as HLS). See the
  [troubleshooting guide](docs/wiki/06-troubleshooting.md).
- If a song title is cut short in its tooltip too, the station may have sent
  it that way.
- If a station starts slowly, give it a few seconds to connect. HLS can take
  longer. Try a backup address for a saved station if you have one.
- A favorite missing from the Tuner dial may be saved as the other type: the
  count under the station list says so. The same guide tells how to fix it.
- If the Visualizer is slow, set **Quality** to Low, **Frame rate** to 15 or 30,
  and choose Light scenes; effects and overlays are off by default, and
  **Settings > Processor use** starts at Low.
- Starting World Media again while it runs with the same data folder brings the
  open window to the front; it does not open a second one. A start made at the
  very moment that window is closing may open nothing: start it again.
- Runtime diagnostics are under `WorldMediaWindows-data\logs\` beside the
  launcher and do
  not contain upstream media URLs or authentication secrets.

## Requirements

- Windows 10 22H2 or Windows 11 (64-bit)
- Microsoft Edge WebView2 Runtime
- Internet access for upstream catalogs and streams

## Build From Source

```powershell
npm install
npm test
npm run build
python -m pip install --cache-dir .\build\local-cache\pip -r requirements-build.txt
python .\build_single_exe.py --skip-frontend
python .\build_windows.py --skip-frontend
```

The output is:

```text
dist\WorldMediaWindows.exe
dist\WorldMediaWindows\WorldMediaWindows.exe
dist\WorldMediaWindows-0.1.19-portable.zip
```

See [docs/BUILD_WINDOWS.md](docs/BUILD_WINDOWS.md) for the full build and smoke
test flow.

## License

MIT. See [LICENSE](LICENSE). Content from the listed sources retains its
original license.

### Bundled DASH playback library

MPEG-DASH playback uses [dash.js 5.2.0](https://github.com/Dash-Industry-Forum/dash.js),
bundled into the frontend under its
[BSD 3-Clause license](https://github.com/Dash-Industry-Forum/dash.js/blob/v5.2.0/LICENSE.md).
DRM-protected MPDs are rejected with an explicit unsupported response; World
Media does not request licenses or accept browser-provided license endpoints.

HLS playback uses vendored
[hls.js 1.5.13](https://github.com/video-dev/hls.js/tree/v1.5.13) under the
[Apache License 2.0](https://github.com/video-dev/hls.js/blob/v1.5.13/LICENSE).
The packaged app exposes its complete third-party notice at
`/THIRD_PARTY_NOTICES.txt` on its localhost runtime.

### Visualizer scenes

The Visualizer's scenes, effects and overlays are ported from
[Psychedelia Studio](https://github.com/aivrar/psychedelia-studio) (MIT, same
author). Some of its shader code is borrowed from others and keeps its own
license. It is credited under **Visualizer credits** on the About page, in
[CREDITS.md](CREDITS.md) and in `/THIRD_PARTY_NOTICES.txt`.

### Optional FFmpeg tool

World Media does not bundle FFmpeg in its EXE. Recording and playback of
Computer formats that need conversion can use an existing capable
`ffmpeg`/`ffprobe` pair or, after explicit confirmation, install
the exact `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` asset from
[FFmpeg-Builds/FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds). The managed archive
is downloaded without administrator access, checked against GitHub's SHA-256
digest, inspected before extraction, capability-probed in staging, and only then
selected atomically. Its license files, install manifest, and `SOURCE.txt` are
retained beside the managed binaries. FFmpeg licensing details are available at
[ffmpeg.org/legal.html](https://ffmpeg.org/legal.html).

The normal unit suite uses small local fixtures. The full current-provider smoke
is intentionally opt-in because it downloads more than 160 MB:

```powershell
$env:WORLDMEDIA_FFMPEG_INTEGRATION = "1"
python .\tests_python\ffmpeg_real_integration.py
Remove-Item Env:WORLDMEDIA_FFMPEG_INTEGRATION
```
