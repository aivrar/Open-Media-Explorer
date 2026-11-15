# Using the application

My Playlists, Add link, and Favorites media/local-search filters require v0.1.3
or newer. Opening on Favorites, the Tuner's **★ My favorites** source, compact
saved-item cards, and the simplified source labels require v0.1.4 or newer.
Favorites sorting and categories, the media type buttons, **Star all**, `.pls`
and `.xspf` import, the song title and Song log, station images, stream
quality, and **Back up my data** require v0.1.9 or newer.

## Window layout

The top bar is shared by every mode:

- **World Media** opens the current view.
- **Library**, **Tuner**, **Grid**, **Discovery**, and **About** switch modes.
- The **Sleep** control starts or cancels the sleep timer.
- The musical note opens the **Song log**.
- The gear opens **Settings**.
- **Shutdown** asks the local runtime to stop catalog workers, artwork, media,
  downloads, recording, and FFmpeg work before the process exits.

The bottom player bar is global. It survives mode switches, so you can start a
station in Library, inspect Grid, and return without losing the current player.
Video appears in an overlay above the bar, at the bottom right. It grows with
the window, and the button in its top-right corner switches between the normal
and a larger size; the choice is remembered. Audio keeps the bar visible
without showing a video element, including radio stations that stream in a
video format (HLS or DASH) but carry no picture.

The speaker button shows a crossed-out speaker when the sound is muted or the
volume is at zero. Point at the volume slider to see the volume as a
percentage: it starts at 80%, and 100% is full volume (there is no boost).
When a radio station sends the title of its current song, the bar shows it
under the station name with a note sign; see **Song log** below.

## Library

Library is the main browse and search surface. When you have saved favorites,
the first Library visit of a session opens on **Favorites**; the full catalog
still loads in the background for **All Sources**. Favorites and My Playlists
use compact one-line cards so many saved items fit on screen.

### Search and filters

The search box accepts ordinary words such as `news`, `BBC`, or `Prelinger`.
Search fan-outs run against every enabled source and stream partial results into
the grid as providers answer. The additional filters are:

- **Country** — ISO-style country code, for example `US` or `GB`.
- **Lang** — language token, for example `en`.
- **Year ≥** and **Year ≤** — inclusive numeric year bounds.

Changing the search starts a new page-0 search generation. An old generation is
cancelled so late responses cannot overwrite the new query. Search results are
bounded to the first page from each source; blank search text returns to the
continuous browse chain.

### Sidebar sections

- **Browse → All Sources** shows the enabled-source pool.
- **Browse → Favorites** switches to the separately persisted favorite pool.
  Its **All / Radio / TV / Audio / Video** buttons filter only favorites, and
  so do its sort buttons and category buttons (see **Favorites order** and
  **Favorites categories** below).
  Its search box searches saved titles, descriptions, and groups locally, without
  sending a provider search. This search and type choice are kept separate from
  public-catalog filters during the session. Country/language/year filters still apply.
- **Browse → My Playlists** opens imported channel lists and direct links. It
  has the same type buttons.
- **By Type** selects Radio, TV, Video, or Audio.
- **By Archive** selects one of the ten source adapters. A source switched
  off in **Settings** is left out of this list until it is switched back on.

The number beside a row is the session count for the selected catalog (or the
persisted favorite count). By default the sidebar stays quiet: a source that
needs attention (rate limited or retrying) shows a small amber dot, and
hovering any source shows its status. With **Settings → Appearance → Show
technical source details** on, each source instead shows a compact status word:

| Label | Meaning |
|---|---|
| **Pull** | More catalog work is available or being scheduled. |
| **Sync** | A live snapshot is being refreshed. |
| **Live** | The source has a current live snapshot. |
| **Wait** | The source is rate limited or retrying after an error. |
| **Stale** | A prior live snapshot is still shown while refresh retries. |
| **Done** | A finite cursor reached an authoritative end. |

The full status summary above the cards groups the currently relevant sources as
**Collecting**, **Waiting**, and **Done**. Status words are intentionally short;
hovering a source exposes the longer reason.

Selecting a sidebar row changes the local filter and re-renders the collected
pool; it does not start a duplicate fetch. The background chain continues for
all enabled sources, so rapidly switching tabs cannot wipe the catalog.

### Import your own channel playlists

![My Playlists and Add link with public sample channels](<../../screenshots/v0.1.3/my-playlists.png>)

1. Open **Library → My Playlists**.
2. Set **Add as** to **TV** or **Radio**.
3. Click **Add link**, paste the URL, optionally enter a name, and click **Add**.
   Leave **Single channel** selected for a direct stream (including HLS `.m3u8`
   or DASH `.mpd`). Choose **Online playlist** to fetch a list of channels
   (M3U, PLS or XSPF). To use a local file instead, click **Import playlist** and
   select the file, or drop the `.m3u`, `.m3u8`, `.pls` or `.xspf` file anywhere
   on the window. A drop opens My
   Playlists and shows the result; dropped on the Tuner, new channels are added
   as the band the dial is on.
4. Choose that playlist (or **All playlists**), search titles/groups, or press
   one of the type buttons (**All / Radio / TV / Audio / Video**). Click a
   channel to play; star it to save it in Favorites, or press **Star all**.

**Star all** adds every channel that is listed under the chosen playlist, type
button and search to Favorites, including channels further down that are not
drawn yet. If more than 25 of them are new, it asks first, because there is no
undo for all of them at once. It stops when Favorites holds 1,000 items. A
short message beside the buttons says how many were added, how many were
already in Favorites, and how many were left out.

Import supports UTF-8 and legacy Windows-1252 text, `#EXTINF` names, `tvg-name`,
`tvg-logo`, `tvg-country`, `tvg-language`, `group-title`, `#EXTGRP`, and `radio`
metadata. Audio filename extensions are recognized when no explicit `radio`
attribute is present. VLC-style HTTP referrer/user-agent options are accepted
when safe. Local file entries must be absolute HTTP(S) URLs; relative stream and
logo URLs in online playlists resolve against the playlist's final URL after
redirects. PLS and XSPF lists are converted to M3U when imported: XSPF track
`title` (or `creator` when there is no title), the first public web `location`,
and `image` as the logo are kept; XSPF files with a DTD or entity declarations
are refused. Unsupported entries and
duplicates are counted in the import result; a wholly invalid list is rejected.
Channel IDs stay stable when only their display names change.

Importing the same filename replaces that saved playlist after confirmation.
**Remove playlist** removes only the selected imported list; it preserves the
original file, saved favorites, and current playback. Imports are snapshots:
reimport the file or add the same online link to update its entries. Links are
identified by URL, so two different links with the same display name do not
overwrite each other. A direct channel is saved without opening a connection;
availability is checked when you play it. They currently appear in Library and
Favorites, not the provider catalogs in Grid, Tuner, or Discovery.

The importer is for live TV/radio channel lists, not local media files, private
network streams, DRM, provider login/cookie workflows, or Kodi/pipe-URL options.
An HLS `.m3u8` containing segments or variants is a playback manifest, not a
channel list; use **Add link → Single channel** for its public URL. Logos and streams
use the same defended relays as built-in sources. Import does not grant any
viewing or recording rights; provider terms and availability still apply.

Files and online playlist responses are limited to 8 MiB and the saved playlist
document to 64 MiB, with a
visible error before saving if exceeded. These are input/storage safeguards,
not limits on the continuously collected public catalog or mounted-card window.

### Continuous collection and large catalogs

At startup the app fetches a page from every enabled source. It then asks ready
sources for more pages in a fair rotation. The scroll sentinel asks for another
page when the user nears the end of the mounted window. **Retry now** retries
waiting sources without changing their cursor. **Check again** resets finite
sources that completed the current catalog and starts another pass.

The resident catalog is not evicted during an ordinary session. The renderer
mounts an initial 300-card window and advances it in 200-card steps; this is a
DOM/reflow safeguard, not a data discard. Items remain searchable and counted,
including sessions well above 40,000 items.

### Cards, detail, and favorites

Each card can contain artwork, title, source, year/country, license, and a star.
Artwork is lazy: the first visible/nearby cards are prioritized and off-screen
cards wait for the viewport. An item without artwork shows its initials on a
coloured square (the same colour every time); a logo that fails can be retried
without affecting the catalog item. Source badges and license notes are shown
when technical source details are switched on.

Click the card body to open its detail panel and start playback. The panel can
show:

- title and description;
- source, country, language, tags, year, and license;
- **Play** or **Try next** behavior for live candidates;
- **Download** when a finite original is available;
- **Record audio/video** when the item is live and FFmpeg is ready;
- a link to the provider's **Source** page.

Radio Browser stations also show the stream format and bitrate the directory
lists, for example "MP3 · 128 kbps": in the detail panel, on the card when
technical source details are on, and in the player bar's tooltip. Their detail
panel has an **Other streams** button that lists other Radio Browser entries for
the same station (same name and same homepage) with a **Play** button each;
nothing is switched for you, and a station without a homepage lists stations
with the same name, which may be different stations. Items from your own
playlists have no station id, so the button is not offered for them.

Click the star on a card, detail panel, or player bar to add/remove a favorite.
Favorites retain stable item identity and favorite-scoped EQ. Short-lived local
artwork and media relay URLs are deliberately removed before persistence and
resolved again on a later launch.

### Favorites order

In **Favorites**, the **Sort** buttons choose how the list is shown.

- **My order** is your own order. New favorites go to the top. Each card has
  three small buttons: move to the top, move up, and move down. A button that
  cannot move the card, such as move up on the first card, does nothing. When
  a type button, a category or the search box is hiding some favorites, up and
  down swap the card with the next favorite you can see.
- **A-Z** sorts by name, and numbers count as numbers, so "Radio 2" comes
  before "Radio 10". It only changes how the list is shown. Your own order is
  kept, and **My order** brings it back exactly.

The Tuner's **★ My favorites** source and its category sources follow the same
choice. It is saved with your settings.

### Favorites categories

Sort favorites into your own categories, such as "Rock" or "Talk". In
**Favorites**, choose **+ New category** in the second row of chips, type a name
(up to 40 characters) and press Enter. Each favorite card has a small tag
button: open it to put that favorite in a category, take it out (**None**), or
make a new category and put the favorite in it in one step. A favorite is in at
most one category. Click a category chip to see only its favorites (it works
together with the type buttons, the search box and both sort orders, and the
move buttons work inside it); **Uncategorized** shows the ones in none. The
chosen chip offers **Rename** and **Delete**; deleting a category keeps its
favorites. In the Tuner each category with favorites appears on the **Source**
list after **★ My favorites**. In a backup, a favorite's category becomes its
group in the favorites `.m3u8` files. Categories are kept in
`profile-preferences-extra.json` beside `profile-preferences.json`, so an older
version of World Media still reads your favorites (without their categories).
**Clear local cache** removes them with the rest of your favorites.

## Grid

Grid is a live guide. Choose **Live TV** or **Radio**, then optionally filter by
category, country, source, and the text **Filter…** box. The built-in category
list includes News, Music, Sports, Movies, Documentary, Kids, Entertainment,
and Education.

Tiles appear as each live source answers; a source that does not answer within
20 seconds is marked unavailable. Click a tile or press Enter/Space while it is
focused to play it. Tile logos are
viewport hydrated, so the first visible rows load before far-away rows. The Grid
and Library share the same artwork relay and playback priority rules.

Grid does not host channels or manufacture schedules. IPTV, Owncast, PeerTube,
Radio Browser, gPodder live entries, and C3VOC contribute whatever public live
items they report at refresh time.

## Tuner

Tuner provides a radio-style way to step through live media:

1. Choose **Radio** or **TV**.
2. Filter by country and source. Source **★ My favorites** puts only your
   starred stations for that band on the dial; the choice is remembered. Each
   of your favorites categories that has stations appears on the list after it,
   named like **★ Rock**. These dials follow the order chosen in Favorites
   (**My order** or **A-Z**).
3. Drag the dial, scroll the mouse wheel over it (one station per notch), use
   Left/Up or Right/Down, or focus the dial and use arrow keys.
4. Press Enter or Space to play the selected item.

The dial shows the selected station's place in the current list ("12 of 80"),
not a broadcast frequency. Starred stations are marked with ★ in the station
strip and on the dial, and the strip keeps the current station in view. The
strip can always scroll so that any station, including the first and the last,
sits in the centre. When the mouse is over a dial that the wheel can turn, the
dial glows softly; a dial with one station does not.
The knob's marker rests at the same angle for the same station, with the first
station at the top. With a single station on the dial, the dial does not turn.
Stations appear as each live source answers; a source
that does not answer within 20 seconds is marked unavailable instead of holding
the dial on "Loading". Tuner reuses the live adapter/snapshot lane and
content-rating preference.

## Discovery

Discovery is a bounded random picker. Select **Any**, **Radio**, **TV**,
**Video**, or **Audio**, then optionally provide country, tag, and source
filters. **Surprise Me** starts a globally scheduled attempt; **Surprise Me
Again** or **Next** chooses another item.

Each provider gets its own deadline and the scheduler cancels losing/expired
attempts. A provider that is slow or unavailable does not block the other
providers indefinitely. Discovery is not a guarantee of uniqueness across all
time; it is a fresh candidate selection from current provider data.

## About

About is a static reference page. It lists the ten sources, their media types,
capabilities, home links, rights notes, privacy guarantees, app version, hls.js
and dash.js notices, and optional FFmpeg licensing information. The counts on
About are descriptive; live counts belong to Library.

## Settings

Open Settings with the gear. Changes that say “immediately” apply without a
restart; the local server port is explicitly marked **for next launch**.

### Appearance

- **Theme:** System, Dark · Teal, Light, Midnight · Blue, Forest · Green,
  Ember · Orange, or Amethyst · Violet.
- **Default mode on launch:** Library, Tuner, Grid, or Discovery (About is
  accepted by the state normalizer but is not offered as a default selector).
- **Show technical source details:** off by default. Turn it on to see the
  per-source status words (Pull, Wait, Done, Live, Stale), boxed source badges,
  and license notes on cards.

The native title bar starts in the saved theme and follows theme changes
immediately, including on Windows 10 (where only its dark/light mode can be
set, not the exact palette colour).

### Content

**Show explicit/NSFW content** is off by default. Turning it on is a deliberate
user gesture and reveals provider-marked items with a visible rating label. It
does not relax URL validation, redirect checks, private-network blocking,
malformed-schema rejection, or Owncast verification. Turning it off hides
marked items everywhere while keeping saved favorites as non-revealing
placeholders.

### Local server

Enter a whole port from `1024` through `65535` and choose **Save for next
launch**. The current process continues on its existing port; restart World
Media to activate the saved port. The app normally uses `9124` and searches a
safe fallback range only when the configured port is occupied. A forced port
environment variable is intended for diagnostics, not ordinary use.

### Capture and storage

- **Recorder:** on by default. Turning it off prevents new recordings and asks
  active recordings/FFmpeg preparation to stop. It reserves playback bandwidth
  and CPU; downloads remain available. An idle recorder uses essentially no
  resources.
- **Recording quality:** Compact (96 kbps/480p), Balanced (160 kbps/720p), or
  High (256 kbps audio/1080p video). Source media is never upscaled.
- **Open downloads:** opens the runtime's approved `downloads` directory.
- The runtime card shows the portable root, downloads root, FFmpeg tools root,
  and whether the portable location is writable.

### Sources

Every source has an independent switch. Disabling a source cancels its queued
catalog/snapshot work and removes its ordinary Library items; existing favorites
remain visible. Re-enabling creates a fresh source progress lane.

### Storage

#### Back up your data

**Back up my data** saves one `.zip` file in the downloads folder, named like
`WorldMedia-backup-20261114-221500.zip`. Before it starts, World Media saves
your latest favorites and settings; if that fails, no backup is made and the
message says so. When it is done, Settings shows the file name and how many
favorites and playlists it holds, with an **Open folder** button.

The ZIP contains:

- `exports\`: playlist files (`.m3u8`) that most players, IPTV apps and
  internet radio apps can open: `favorites-radio.m3u8`, `favorites-tv.m3u8`,
  `favorites-other.m3u8` (videos and audio), and one file for each playlist you
  imported. These files are cleaned: they hold only the web addresses World
  Media can play, with names, groups and pictures; player options and other
  lines are left out. A file is only made when it has at least one entry.
  Favorites without a direct stream address (items World Media looks up again
  each time you play them) cannot go in these files; the README says how many.
- `WorldMediaWindows-data\state\`: a copy of `playlists.json` (your imported
  playlists) and `profile-preferences.json` (favorites, settings, volume and
  equalizer curves). Old download history is left out of the copy. When you
  have a song log, `song-log.json` is copied too.
- `WorldMediaWindows-data\station-images\`: your own station pictures (see
  below), when you have any. Only pictures World Media actually uses are
  copied. If they would push the backup over its 192 MB limit, the ones that
  do not fit are left out and the README says how many.
- `README.txt`: what each file is and how to use it.

Cache, logs, browser data, FFmpeg tools, downloads and the saved local port are
never included.

There is no restore button. To restore by hand, close World Media, copy the
`WorldMediaWindows-data` folder from the ZIP (it holds `state` and, if you had
pictures, `station-images`) into the folder that holds `WorldMediaWindows.exe`,
let it replace files with the same names, and start World Media again. Imported
playlists come back straight away. Favorites and settings are only taken from
the backup by a copy of World Media that has none of its own yet, such as a new
computer or a fresh copy of the app.

Playlist addresses can contain private links or account tokens, so share a
backup only with people you trust.

#### Station images

You can give any station your own picture. Press **Open folder** under
**Station images**; World Media makes a `station-images` folder inside the
`WorldMediaWindows-data` folder next to the app (so it travels with the
portable folder) and opens it. Put a picture in it named exactly like the
station, for example `Radio Paradise.png`, then press **Refresh**. The status
line says how many pictures were found and why any were ignored, for example
`12 pictures found. 1 ignored: too large.`

- The name is compared without caring about capital letters, extra spaces, or
  characters Windows does not allow in file names (`\ / : * ? " < > |`), so
  `radio paradise.png` also works for a station called `Radio Paradise`, and
  `ACDC Radio.png` for `AC/DC Radio`. A dot at the end of a station's name is
  ignored too.
- PNG, JPG, WebP or GIF, up to 2 MB each, at most 2,000 pictures. Each one is
  checked to be a real image of that kind; anything else (an SVG, a renamed
  text file) is ignored.
- If two files would match the same station, the one whose file name sorts
  first is used, so `Radio Paradise.jpg` wins over `Radio Paradise.png`.
- The picture is used everywhere the station appears: cards, favorites,
  imported playlists, the detail panel, the player bar and the Tuner. If a
  picture cannot be shown, the station's own logo (or its initials) is shown
  instead.
- Only plain files directly in the folder are used. Subfolders, shortcuts and
  links are ignored.

World Media lists the folder when it starts and again whenever you press
**Refresh**. Nothing about the pictures is stored in your settings.

#### Clear local cache

**Clear local cache** is a reset, not a thumbnail-only cleanup. It removes
favorites, favorites categories, preferences, volume, EQ, and job history from
the browser profile, empties the song log, and clears catalog/artwork cache
records. It keeps downloaded media, imported playlists, your station pictures,
and managed FFmpeg tools. Back up the data directory before using it. If the
saved copy in your data folder cannot be cleared, Settings stays open and says
so; press **Clear cache** again before closing World Media.

## Song log

Many internet radio stations announce the song they are playing, and the player
bar shows it. World Media keeps a list of these songs: open it with the musical
note in the top bar. The newest song is at the top, with the date and time it
started and the station. A song is added once, even if you pause or the
station reconnects; another station playing the same song gets its own line.
The list keeps the newest 500 songs. **Copy** puts a song's title on the
clipboard, for example to look it up, and **Remove** takes it off the list.
**Save to file** writes the list as a spreadsheet file
(`WorldMedia-song-log-20261115-093005.csv`, with the columns Date, Time, Song
and Station) into the downloads folder; **Open folder** then shows it.
**Clear log** empties the list after asking. The log is saved in the
`WorldMediaWindows-data\state` folder as `song-log.json`, so it stays when you
change the local port, is included in backups, and is emptied by **Clear local
cache**. Older versions of World Media ignore this file. If the saved log
cannot be read, World Media starts a new one and keeps the old file in the same
folder as `song-log-unreadable-<date>-<time>.json` (the newest three are kept;
backups leave them out).

## Sleep timer

The Sleep selector offers Off, 1 minute, 15 minutes, 30 minutes, 1 hour,
2 hours, and Custom (0.1–720 minutes). Ten seconds before expiry it fades both
audio and video volume, pauses playback, restores the pre-fade volume, and
cancels itself.

## Keyboard and accessibility

Cards, sidebar rows, dialogs, the tuner dial, sliders, and buttons expose
keyboard focus and ARIA labels. Enter/Space activates focused cards and tuner
selection; arrow keys navigate sidebar/tuner controls; Escape closes Settings
and EQ dialogs. Reduced-motion and forced-colors behavior is covered by the
frontend accessibility tests.
