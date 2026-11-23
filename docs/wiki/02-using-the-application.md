# Using the application

My Playlists, Add link, and Favorites media/local-search filters require v0.1.3
or newer. Opening on Favorites, the Tuner's **★ My favorites** source, compact
saved-item cards, and the simplified source labels require v0.1.4 or newer.
Favorites sorting and categories, the media type buttons, **Star all**, `.pls`
and `.xspf` import, the song title and Song log, station images, stream
quality, and **Back up my data** require v0.1.9 or newer. The sound meter in
the player bar and the **Tuner card size** setting require v0.1.10 or newer.
The **Visualizer** tab, **Add as: Auto**, **Move to bottom**, **Remove all
favorites** and the list of pictures that were not used require v0.1.11 or
newer. Starred songs, **Rename** for favorites, dragging favorites in **My
order**, `.json` and `.csv` import, **Pick the best stream** and **Processor
use** require v0.1.12 or newer. The **Now Playing** tab, the "!" mark on a
station that did not play, **Choose picture…** and dropping a picture on a
station's card require v0.1.13 or newer. The stream format and bitrate of
a station that has played, the volume control, the one-row player bar, the
mouse wheel over the Tuner's station strip, the Tuner's **Visualizer:** control
and one running copy per data folder require v0.1.16 or newer.

## Window layout

The top bar is shared by every mode:

- **World Media** opens the current view.
- **Library**, **Tuner**, **Grid**, **Discovery**, **Now Playing**,
  **Visualizer**, and **About** switch modes.
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

In a window wider than 1000 px the bar is one row, 74 px high, with every
control on one centre line; in a window 1000 px wide or narrower its rows are
stacked (168 px). Nothing is written under the buttons: why the **Record**
button is unavailable is its hover text (with **Recorder** off it says where to
turn it on: Settings, Capture & storage), and a capture's progress, result or
error shows beside the button. The gear at the top opens Settings.

The speaker button shows a crossed-out speaker when the sound is muted or the
volume is at zero. The volume control beside it is an up button, the volume as
a number from 0 to 100, and a down button (in a window 1000 px wide or narrower
it has a row of its own: down, number, up). Point at it to see the volume as a
percentage: it starts at 80%, and 100% is full volume (there is no boost). A
click on a button changes the volume by 1, a held button repeats after 0.4
seconds, the mouse wheel over the control changes it by 2 per notch, and with
the control focused the arrow keys change it by 1, Page Up and Page Down by 10,
and Home and End set 0 and 100. The number and the speaker also follow a
video's own volume and mute controls.
When a radio station sends the title of its current song, the bar shows it
under the station name with a note sign, and a star beside it stars that song;
see **Song log** below. The song is shown larger and brighter than the rest of
the line, and both the song and the station name grow with the window on large
screens (the song from 14 px in a 1024 px wide window to 22 px in one about
2,800 px wide or wider).
A title too long for the bar ends in an ellipsis; point at it to read all of
it. The Tuner dial's station name grows with the window the same way.

The **sound meter** is a row of small LED-style bars beside **EQ** that move
with the sound, so you can see that a station is really playing. It has 14 bars,
from the lows on the left (about 40 Hz) to the highs on the right (about
16 kHz), and each bar keeps a falling peak segment. It only reads the sound and
never changes what you hear. It rests, with flat bars, while playback is
paused or stopped and while the sound is muted or the volume is at zero, and it
slows to about one update a second while the window is minimized. In a wide window it sits at the start of the
progress row and is left out when that row is too short; in a window up to
1000 px wide it sits at the end of the button row. Turn it off with **Settings >
Appearance > Sound meter in the player bar**. It also stays off when Windows is
set to show fewer animations. See
[Playback](04-playback-eq-downloads-recording.md) for when it has no sound to
show.

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

![My Playlists and Add link with public sample channels](<../../screenshots/v0.1.14/my-playlists.png>)

1. Open **Library → My Playlists**.
2. Leave **Add as** on **Auto**, or set it to **TV** or **Radio**. It decides
   the type of the channels that do not say whether they are radio or TV (see
   below).
3. Click **Add link**, paste the URL, optionally enter a name, and click **Add**.
   Leave **Single channel** selected for a direct stream (including HLS `.m3u8`
   or DASH `.mpd`). Choose **Online playlist** to fetch a list of channels
   (M3U, PLS, XSPF, JSON or CSV). To use a local file instead, click **Import playlist** and
   select the file, or drop the `.m3u`, `.m3u8`, `.pls`, `.xspf`, `.json` or `.csv` file anywhere
   on the window. A JSON or CSV list needs a `url` for each station (a CSV file
   starts with a header row such as `name,url`); `name`, `logo`, `group` and
   `type` (radio or tv) are used when given. A Radio Browser JSON export works
   as it is. A drop opens My
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

**Add as** matters only for channels that do not say what they are. A mark in
the file decides: `radio="true"` makes a channel radio, and `radio="false"`
makes it TV, even when its address ends in an audio file extension. Only a
channel with no mark is radio because its address ends in an audio file
extension. For the other channels:

- **Auto** (the default) uses the type that most channels in the same file say.
  If the file does not decide (no channel says, or it is a tie), it uses TV, as
  every import did before Auto existed.
- **TV** and **Radio** give those channels that type.

When some channels had to be given a type, the import result says how many, and
with Auto it says what it chose and why, so a wrong guess is easy to fix:
choose the other type in **Add as** and import the file again. When every
channel says its own type, there is nothing to report. Auto is saved as
the type it chose, so older versions of World Media can still read the list.

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
duplicates are counted in the import result. It also says how many entries were
skipped because they point at this computer or a private network address, and
why. A wholly invalid list is rejected. Two entries with the same address and type are one channel when
their names are the same too. With different names both are kept. Channel IDs
stay stable when only their display names change.

**JSON and CSV lists.** A JSON list is a list of stations, or an object that
holds one under `stations` or `channels` (`items`, `entries`, `playlist`,
`tracks` and `streams` work too). Each station is an object with at least a
stream address (`url`; `url_resolved`, `stream_url` and similar names are read
too), or just the address as text. A CSV list starts with a header row that
names its columns, separated by commas, semicolons or tabs, and one column must
be the stream address (`url`). Columns for the name (`name` or `title`), the
picture (`logo`, `favicon` or `image`), the group (`group`, `category` or
`genre`), the type (`type` with radio or tv, or `radio` with true or false),
`country` and `language` are used when they are there. Capital letters do not
matter, and a space in a column name counts as `_`, so `Stream URL` is read as
`stream_url`. A CSV list without a header row is read too when its first row
holds a web address: that column is the stream address and the first other
column the name. Like PLS and XSPF, JSON and CSV lists are kept as M3U, so older
versions of World Media can still read them. When a file cannot be read, the
message says why and what to do (for example, that a CSV list has no column
for the stream address and one column must be named `url`), and for a broken
file near which line.

Importing the same filename replaces that saved playlist after confirmation.
A channel's ID is made from its type and address. So when you import a
playlist again and a channel has changed between radio and TV (for example
after you chose **Add as Radio** this time), its old favorite would point at a
channel that no longer exists. World Media therefore moves each such favorite
to the new channel (same address and same name, the other type). It keeps the
favorite's place in My order, its category and its own equalizer curve, and the
import result says how many were moved. A favorite is left alone when the
channel's name changed or the new channel is already a favorite. If the change
cannot be saved, nothing changes and the result says so.

**Remove playlist** removes only the selected imported list; it preserves the
original file, saved favorites, and current playback. It asks first, with the
playlist's name and its number of channels. If you have several playlists, first
choose the one to remove in the list that says **All playlists**; with only one
playlist, that one is meant. To change the stations of a playlist, edit your own
playlist file and import it again under the same file name. The copy that World
Media keeps is not meant to be edited by hand. Imports are snapshots:
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

Files and online playlist responses are limited to 8 MiB, a JSON or CSV list
to 50,000 entries, and the saved playlist document to 64 MiB, with a
visible error before saving if exceeded. These are input/storage safeguards,
not limits on the continuously collected public catalog or mounted-card window.

### Continuous collection and large catalogs

At startup the app fetches a page from every enabled source. It then asks ready
sources for more pages in a fair rotation. The scroll sentinel asks for another
page when the user nears the end of the mounted window. **Retry now** retries
waiting sources without changing their cursor. A source that does not answer
is tried again by itself every few minutes, and its page says so. **Check again** resets finite
sources that completed the current catalog and starts another pass.

The resident catalog is not evicted during an ordinary session. The renderer
mounts an initial 300-card window and advances it in 200-card steps; this is a
DOM/reflow safeguard, not a data discard. Items remain searchable and counted,
including sessions well above 40,000 items.

### Cards, detail, and favorites

Each card can contain artwork, title, source, year/country, license, and a star.
Artwork is lazy: the first visible/nearby cards are prioritized and off-screen
cards wait for the viewport. An item without artwork shows its initials on a
colored square (the same color every time); a logo that fails can be retried
without affecting the catalog item. Source badges, license notes and the
stream's format and bitrate are shown on the card when technical source details
are switched on. Channels from your own
playlists show no license note: the same "See provider terms" on every card
told you nothing about a stream you added yourself.

Click the card body to open its detail panel and start playback. The panel can
show:

- title and description;
- source, country, language, tags, year, and license;
- **Play** or **Try next** behavior for live candidates;
- **Download** when a finite original is available;
- **Record audio/video** when the item is live and FFmpeg is ready;
- a link to the provider's **Source** page.

A station's stream format and bitrate show as one short label, for example
"MP3 · 128 kbps": in the detail panel, in the tooltip of its card in the
Library and the Tuner ("Stream: MP3 · 128 kbps"), on the Library card when
technical source details are on (on the Tuner card in a short form, such as
"AAC+ 320k · My Playlists"), and in the player bar's tooltip. Radio Browser
lists them for its stations. Since v0.1.16 the app also remembers what a
station's own stream said the last time it played, so a station from another
source, a playlist station for example, shows them after it has played once; a
station delivered as HLS does not (see
[Playback](04-playback-eq-downloads-recording.md#stream-format-and-other-streams)).
The detail panel of a Radio Browser station has an **Other streams** button that
lists other Radio Browser entries for
the same station (same name and same homepage) with a **Play** button each.
A station without a homepage lists stations with the same name, which may be
different stations. **Pick the best stream** set to **Auto (verified)** (see
Content below) uses one of these entries on its own only after it passed every
check, which takes two checks a few minutes apart that each find both streams
playing the same song (a different song each time), so it works only for a
station that announces song titles; same-name-only entries are never used. Items from your own
playlists have no station id, so the button is not offered for them.

Click the star on a card, detail panel, or player bar to add/remove a favorite.
Favorites retain stable item identity and favorite-scoped EQ. Short-lived local
artwork and media relay URLs are deliberately removed before persistence and
resolved again on a later launch.

### Favorites order

In **Favorites**, the **Sort** buttons choose how the list is shown.

- **My order** is your own order. New favorites go to the top. Each card has
  four small buttons in a 2 x 2 block: **Move to top**, **Move up**, **Move
  down** and **Move to bottom**. A button that cannot move the card, such as
  **Move up** on the first card, does nothing. When a type button, a category
  or the search box is hiding some favorites, up and down swap the card with
  the next favorite you can see, and the top and bottom buttons put the card
  before or after all the others.
- In **My order** you can also drag a card with the mouse and drop it
  anywhere on another card: it takes that card's place, and the cards in
  between move up or down by one. A colored edge shows where it will go: on
  the top and left of that card when you move a card up the list, on the
  bottom and right when you move it down. Letting go in a gap between cards,
  or on the card you are dragging, changes nothing. With a type button, a
  category or the search box hiding some favorites, only the cards you can
  see change places; the hidden ones keep theirs.
  Dragging a playlist file onto the window is never taken for a move. The
  **Move** buttons do the same from the keyboard.
- **A-Z** sorts by name, and numbers count as numbers, so "Radio 2" comes
  before "Radio 10". It only changes how the list is shown. Your own order is
  kept, and **My order** brings it back exactly.

The Tuner's **★ My favorites** source and its category sources follow the same
choice. It is saved with your settings.

With **Settings > Appearance > Show technical source details** on, the cards
in **My order** are a little wider, so the source badge fits whole beside the
**Move** buttons.

### Rename a station

Open a favorite's detail panel and press **Rename** to give it a name of your
own, up to 80 characters. Type the name and press **Save** (or Enter);
**Cancel** or Escape closes the form without a change. Leaving the name empty
brings back the original name, and so does **Use original name**, which the
panel shows once a favorite has a name of your own. The panel also shows
"Original name:" with the station's own name.

The new name is shown everywhere that favorite is: the Library cards, the
Tuner's dial and cards, the player bar, the song log and starred songs (for
songs heard from then on), and the favorites `.m3u8` files in a backup.
**A-Z** sorts by it, and the Favorites search finds a renamed favorite by
either name. A station picture named after the station's own name still
belongs to it; without one, a picture named after the new name is used.
Lookups in the station directory, such as **Other streams**,
always use the station's own name. Rename works for any favorite, radio or TV.
Only favorites can be renamed; remove the favorite and its name goes too.

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

### Did not play last time

When the last try to play a favorite or a My Playlists station failed (none of
its streams worked, or the last of them did not begin within 30 seconds), its
Library card and its card in the Tuner strip show a small red **!**. Point at
it, or open the detail panel, to read "Did not play last time (date). It is
tried again when you play it." The mark never stops you: press Play as usual,
and it goes as soon as the station plays. Stopping a station, choosing another
one before it starts, a start Windows or the browser holds back until you
press Play, or closing the app does not count as a failure. A station with
more than one stream is only judged once every stream has had its turn.

A failure caused by your connection, not the station, is not marked either.
Nothing is marked while Windows reports no connection, or when the station's
address could not be looked up at all. When a station could not be reached,
World Media marks it only if something on the internet answered within the
last minute, or if a small check (Radio Browser's short statistics page, at
most once every 30 seconds) gets an answer; otherwise nothing is marked. The
check never holds up a play. A result still waiting for the check is dropped
if that station plays meanwhile, if you clear the cache, or after two minutes. Stations you have not saved are not marked. The
marks are kept only on this computer, at most 2,000 of them, are not part of
a backup, and **Clear local cache** removes them.

### Remove all favorites

**Remove all favorites** is at the end of the sort row in **Favorites**. You can
press it only while you have favorites. It asks first and says how many it will
remove, for example "Remove all 12 favorites? This cannot be undone. To keep a
copy, first use Back up my data in Settings > Storage." Nothing is removed
without a yes. It removes the favorites and their own equalizer curves. Your
category names and your other settings stay. If the list cannot be saved,
nothing is removed and a message says so. In the one case where the curves
could not be put back, the favorites stay but now use the main equalizer, and
the message says that too. To remove just one favorite, press its star.

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
3. Drag the dial, scroll the mouse wheel over it or over the strip of station
   cards under it (one station per notch), use Left/Up or Right/Down, or focus
   the dial and use arrow keys.
4. Press Enter or Space to play the selected item.

With **My favorites** (or one of your categories) as the source, the status
line says how many favorite stations are on the dial. The dial shows the
favorites saved as the type you are on: radio stations on the Radio dial and
TV channels on the TV dial. When some of your favorites are saved as the other
type, the status line adds a note, for example "3 more saved as TV (switch to
TV to see them)". A playlist channel whose address does not
say radio or TV is saved as the type of its playlist's **Add as** choice, so a
radio station imported as TV is only on the TV dial. Import the playlist again
with the right **Add as** to move it.

The dial shows the selected station's place in the current list ("12 of 80"),
not a broadcast frequency. Starred stations are marked with ★ in the station
strip and on the dial, and the strip keeps the current station in view. The
strip can always scroll so that any station, including the first and the last,
sits in the center. When the mouse is over a dial that the wheel can turn, the
dial glows softly; a dial with one station does not.
The knob's marker rests at the same angle for the same station, with the first
station at the top. With a single station on the dial, the dial does not turn.
The knob shows only the station's name; its source (for example "My Playlist")
is on the station's card in the strip below. A name too long for the knob is
cut short with an ellipsis and shows in full when the pointer rests on it.

**Settings > Appearance > Tuner card size** sets the size of the station cards
in the strip: **Small** (the default, text only, as in earlier versions),
**Medium** or **Large**. Medium and Large cards have bigger names and show the
station's picture: your own station picture if you have one, otherwise the
station's logo, otherwise its initials on a colored square. Pictures load only
for the cards you can see, and only after the strip has stopped moving, so
turning the dial quickly through many stations asks for nothing until it
rests. Bigger cards leave less room for the dial in a short window; when the
dial gets too small, the station name and then the count are left off the knob.

At the right of the Tuner's top bar, after **Country** and **Source**, the
**Visualizer:** control (a down button, a number and an up button, the same kind
of control as the volume) sets how strongly the Visualizer shows behind the
Tuner, from 0 to 100. The default, 8, is a faint picture; 100 shows it at full
strength, and above the default the picture can make text on the Tuner harder
to read. A click changes the level by 1, a held button repeats, the mouse wheel over the control
changes it by 2 per notch, and with the control focused the arrow keys change it
by 1. 0 turns **Show the Visualizer behind the Tuner** off, and pressing up from
0 turns it on; the switch in Settings and the control follow each other, and
turning the switch off in Settings keeps the level for when it is turned on
again. Nothing is drawn until the notice about flashing pictures has been
accepted in the Visualizer tab, at any level.

The dial keeps the same size while you use it: it does not change between
stations, while a list is loading or empty, or when the player bar appears on
the first play. Before anything has played, the Tuner keeps the player bar's
room free.
Stations appear as each live source answers; a source
that does not answer within 20 seconds is marked unavailable instead of holding
the dial on "Loading". If the dial stays empty because a source did not answer,
it says "The stations could not be loaded. Press Radio or TV above to try
again." (since v0.1.12; before, it said "No stations found for this
country."). Tuner reuses the live adapter/snapshot lane and
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

## Now Playing

**Now Playing** shows whatever plays now, large: the station or item picture
(your own station picture when you have one, else its artwork, else the same
initials tile the cards show), its name (your own name for a renamed favorite,
with the original name under it) and, for a favorite, its category. A star
beside the name adds it to or removes it from your favorites. For radio and
other live audio, the song announced is shown in large type, with the same star as
the player bar (shown only when the title looks like a song) and **Copy**;
when the station announces no title, the tab says so. **Stream details** lists
what the app already knows: the source, the type, the format and bitrate of
the stream that plays, the **Better stream** line of **Pick the best stream:
Auto**, the country and language when the item has them, and how long it has
played (only time with sound counts, not connecting or buffering; a pause is
marked). Below the song a large
copy of the sound meter moves with the sound (the setting **Sound meter in the
player bar** switches only the small one); like the small one, it rests with
flat bars when there is no sound to show, and it stays still when Windows is set
to show fewer animations. The background is a blurred, dimmed copy of the
picture. Play, pause and stop stay in the player bar, and a TV channel or video
keeps playing in its own square. With nothing playing, the tab says so and
offers the Library and the Tuner. Nothing in the tab runs while it is closed.

## Visualizer

The Visualizer shows pictures that move with the sound of whatever is playing:
103 scenes, post effects, overlays, a shuffle, and favorites of its own. It
shows moving, flashing pictures, so a notice about photosensitivity comes first.
It loads only when you open the tab and costs nothing while the tab is closed,
unless you turned on the setting that shows it behind the Tuner.
It has its own page: [Visualizer](09-visualizer.md).

## About

About is a static reference page. It lists the ten sources, their media types,
capabilities, home links, rights notes, privacy guarantees, app version, hls.js
and dash.js notices, a **Processor use** section that explains the levels of
that setting (see **Processor use** below), the **Visualizer credits** for the
shader code the Visualizer borrows, and optional FFmpeg licensing information.
The counts on About are descriptive; live counts belong to Library.

## Settings

Open Settings with the gear. Changes that say “immediately” apply without a
restart; the local server port is explicitly marked **for next launch**.

### Appearance

- **Theme:** System, Dark · Teal, Light, Midnight · Blue, Forest · Green,
  Ember · Orange, or Amethyst · Violet.
- **Default mode on launch:** Library, Tuner, Grid, or Discovery (About is
  accepted by the state normalizer but is not offered as a default selector).
- **Tuner card size:** Small (default), Medium or Large. Medium and Large show
  each station's picture on its card under the Tuner dial. Updates immediately.
- **Sound meter in the player bar:** on by default. Shows the small bars beside
  EQ that move with the sound. Updates immediately.
- **Show the Visualizer behind the Tuner:** off by default. While sound plays,
  the Visualizer is drawn faintly behind the Tuner (how strongly is set with
  the **Visualizer:** control on the Tuner tab), without overlays or effects,
  once its notice about flashing has been accepted in the Visualizer tab. See
  [Visualizer](09-visualizer.md).
- **Show technical source details:** off by default. Turn it on to see the
  per-source status words (Pull, Wait, Done, Live, Stale), boxed source badges
  and license notes on cards, and on station cards the stream format and
  bitrate (such as MP3 · 128 kbps) once a station has played or its directory
  lists them. With it off, a source's status and a station's format and bitrate
  still show on hover.

The native title bar starts in the saved theme and follows theme changes
immediately, including on Windows 10 (where only its dark/light mode can be
set, not the exact palette color).

### Content

**Show explicit/NSFW content** is off by default. Turning it on is a deliberate
user gesture and reveals provider-marked items with a visible rating label. It
does not relax URL validation, redirect checks, private-network blocking,
malformed-schema rejection, or Owncast verification. Turning it off hides
marked items everywhere while keeping saved favorites as non-revealing
placeholders.

**Pick the best stream** has three choices: **Off**, **Listed streams** (the
default) and **Auto (verified)**. With **Listed streams**, when a station or channel lists
several streams, the best listed one is tried first: for TV the largest picture
size (1080p before 720p); for radio the highest bitrate up to 320 kbps, and at
equal bitrate Opus or AAC before MP3. Lossless streams are tried last. If the
best stream does not connect, the next one is tried, and the station's own
stream always keeps a place in the list. The best stream gets six seconds on
its own; if it has not started by then (or fails sooner), the next one is tried
as well and whichever starts first plays. A stream can also connect and then
never begin (its list of parts answers, its sound or picture does not): then
the streams not tried yet get their turn, in the same order, as soon as the
player gives up on it and at the latest 30 seconds after it connected. A stream
that has begun (it started playing and moved on) is not cut off at 30 seconds:
it gets 10 seconds from when it started to play one full second, and only if
it does not is the next stream tried. Once it has played a full second, a later
interruption is handled by the player's usual reconnecting, not by trying other
streams.
**Off** works as in earlier versions: the first two listed streams are tried
together and the first to answer plays; the others are tried only if both fail.
Playing never changes the address a favorite is saved with.

**Auto (verified)** does the same and, for a Radio Browser station, may also
use another directory entry of the same station, but only when there is
evidence that it is the same station and really better. It never delays a
start and never looks anything up before one. After a station has played for
about 45 seconds (counted from when its sound starts, not from when it
connected), a check runs in the background:

- the entry must have the same name, the same homepage, the same country (both
  must give one) and a stream address on the same site as the station's own
  stream (on shared hosting such as github.io, the very same host). This only
  narrows the choice; the content check below is what proves it is the same
  program. An https station is never moved to plain http;
- the directory's own last check of the entry must have passed, and the entry
  must have been unchanged for at least 30 days, with some votes or plays;
- both streams are then opened briefly (at most 8 seconds in all, a limited
  amount of data, one check at a time). Both must say their format and
  bitrate, the other stream's must be what the directory lists and better than
  the station's own, neither may be redirected from https to plain http or off
  the station's site, both must give the same station name, and both must be
  playing the same song: a title of the form "Artist - Title" that is not the
  station's name, an advert or a jingle.

One match is not enough: a second check, a few minutes later in the same
listening (or at a later play), must find both streams on the same song again,
and a different song from the first time. Only then is the stream verified. At
most two checks run per station a week. Pausing, changing station, or
switching **Pick the best stream** to **Listed streams** or **Off** stops a
check on its way, and nothing from it is kept; after a pause, the next check
waits again for about 45 seconds of playing. If the station directory does not answer the lookup in
time, that is not taken as a finding: the check is tried again after 30
minutes.

A station that does not announce song titles could not be verified and keeps
its own stream. A verified stream is used from the next start of that station
for a week; a failed check is not repeated for a day. Once a stream is
verified, the station's detail panel says so at once, for example **Better
stream: 320 kbps MP3, verified. It is used from the next start.**, and offers
**Use the station's own stream**: choosing it then keeps the station on its own
stream, and nothing restarts. While the verified stream plays, the player
bar's tooltip and the detail panel say **Better stream: 320 kbps MP3,
verified**, and the same button goes back to the station's own stream at once.
The choice is remembered for that station (also in a backup). If the verified
stream does not connect, or is redirected to plain http, the station's own
stream plays at once and the verified one is not tried or checked again for a
day; the same happens if it connects but does not play. **Clear cache**
forgets all check results; the stations you keep on their own stream stay.

With **Auto (verified)**, the detail panel of a Radio Browser station has one
quiet line under the stream details that says what the checks know so far:
**Better stream: checking...** (while this station plays and a check is
planned), **one match so far, checking again later**, **none found**, **could
not be verified (this station sends no song titles)**, **could not be
verified**, or the verified stream. It changes as the checks go, also while
the panel is open. With **Listed streams** or **Off** the line is not shown.

### Processor use

**Processor use** sets how much of the computer the Visualizer may use. It
changes nothing while the Visualizer is not playing.

- **Low (default):** the app works as it always has. The Visualizer lowers its
  picture quality when the computer cannot keep up and does not raise it again
  by itself, and the app does not check how busy the processor is. A picture
  drawn without a graphics card starts at Low quality.
- **Balanced** and **High:** the Visualizer may use more of the processor, up
  to the **Limit**, a share of the whole processor (all cores together). The
  limit starts at 40% for Balanced and 60% for High; you can set it from 2% to
  80%. It is kept in whole percent, a number outside that range is set to the
  nearest end, and "The limit is from 2% to 80%." shows under **Limit** for a few seconds.
  Choosing a level puts the limit back to that level's start. While the
  Visualizer plays, the app checks every few seconds how much of the
  processor it and its window use. Over the limit for a few seconds,
  the picture quality steps down; with plenty of room for a while, it steps back
  up, slowly. Without a graphics card, pictures start at the quality you chose
  instead of Low. In the Visualizer's shuffle, the default **Scenes** choice
  takes heavy scenes too. The Visualizer's **Quality** offers **Very high**
  too; it is sharper than High only where the picture is bigger than High
  draws at every pixel (a little over a full 1920 x 1080 screen), such as on a
  2560 x 1440 screen. At **High**, the simulations Curl-Noise Silk, Fluid Ink
  and Physarum start at a larger size when **Quality** is High or Very high.
  No level shows more effects or overlays at once: it stays at three of each.

With a graphics card the Visualizer usually needs only a small share of the
processor, so the limit matters most on computers without one or with few
cores.

The limit is a target the app steers by, not a hard cap: playing the sound is
never held back to meet it. At the higher levels the computer may get warmer
and its fans louder, a laptop's battery may last less, and other programs may
slow down. The flash and brightness safety limits of the Visualizer are the
same at every level. At **Low** the **Limit** box is off. **What this means**
opens the same explanation on the About page. To go back, choose **Low**; it
takes effect at once.

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
  equalizer curves). Old download history is left out of the copy.
  `profile-preferences-extra.json` (your favorites categories, the names you
  gave your favorites, and the stations you keep on their own stream),
  `song-log.json` and `starred-songs.json` are copied too when you have them.
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
playlists, the song log and starred songs come back straight away. Favorites
and settings are only taken from the backup by a copy of World Media that has
none of its own yet, such as a new computer or a fresh copy of the app.

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

- The name is compared without caring about capital letters or extra spaces, so
  `radio paradise.png` also works for a station called `Radio Paradise`. A dot
  at the end of a station's name is ignored too.
- Windows does not allow `\ / : * ? " < > |` in file names, so a station whose
  name has one of them cannot have a file named exactly like it. Write each of
  those characters as `-`, `_` or a space, or leave it out. The station
  `Nu-Metal/Alternative` can use `Nu-Metal-Alternative.png`,
  `Nu-Metal_Alternative.png`, `Nu-Metal Alternative.png` or
  `Nu-MetalAlternative.png`, and `AC/DC Radio` can use `AC-DC Radio.png`. A name
  that Windows keeps for itself, such as `CON`, `AUX`, `NUL`, `COM1` or `LPT1`,
  takes a `_` or `-` at the end: `AUX_.png`. The rule is also written in
  **Settings > Station images**.
- If several pictures fit one station, the first of these is used, comparing
  the names from left to right: `-`, then `_`, then a space, then a left-out
  character. So `Rock-Pop.png` wins over `Rock_Pop.png`, then `Rock Pop.png`,
  then `RockPop.png`. A picture named exactly like a station always belongs to
  that station. If one picture fits two stations, it goes to one of them, the
  same one every time, and the other uses its next choice.
- PNG, JPG, WebP or GIF, up to 2 MB each, at most 2,000 pictures. Each one is
  checked to be a real image of that kind; anything else (an SVG, a renamed
  text file) is ignored.
- If two files would match the same station, the one whose file name sorts
  first is used, so `Radio Paradise.jpg` wins over `Radio Paradise.png`.
- The picture is used everywhere the station appears: cards, favorites,
  imported playlists, the detail panel, the player bar, Discovery and the
  Tuner (on Medium and Large cards). If a picture cannot be shown, the
  station's own logo (or its initials) is shown instead.
- Your picture is always shown whole and centered, never cut off, so a picture
  that is not square (a wide logo, for example) keeps its sides. The space
  beside it stays plain.
- Only plain files directly in the folder are used. Subfolders, shortcuts and
  links are ignored.

You can also give a favorite or a My Playlists station a picture without
opening the folder. In the station's detail panel (where **Rename** is), press
**Choose picture…** and pick a PNG, JPG, WebP or GIF file of up to 2 MB, or
drop one picture file on the station's card in **Favorites** or **My
Playlists**. World Media checks the picture exactly as it checks the folder
(an SVG or a file that is not really a picture is refused, with the reason),
then saves a copy in the `station-images` folder, named after the station by
the rules above. For example, `Nu-Metal/Alternative` gets
`Nu-Metal-Alternative.png`. A renamed favorite's picture is named after the
station's own name. If a file is already there for the station, you are asked
before it is replaced, and the question names it, for example "The file
AC-DC.png is already there. Replace it?". The new picture shows at once on the
cards, the Tuner and the player bar. **Remove picture**, shown while the
station has a picture of its own, asks first, naming the file or files it will
delete, and then deletes only those files from the folder. For a renamed
favorite whose picture is named after your name for it, that one file is the
one named and deleted. File names are always shown in full. If more than 20
files in the folder belong to one station, nothing is replaced or deleted and
a message asks you to tidy the folder by hand first. A picture dropped anywhere else changes nothing; a message says where to
drop it. A playlist file dropped on the window is still imported as before.

Under the status line, **Pictures to check** lists the files in the folder that
need a look, each as the file name and the reason. It shows up to ten lines and
then "and N more". It lists:

- files that were not used at the last scan, with the reason in plain words:
  "too large (the limit is 2 MB)", "not a valid picture", "SVG is not allowed",
  "not a supported picture type", "another picture has the same name", "a link,
  not a file", "file name not allowed", "over the 2,000 picture limit" or
  "could not be read";
- a picture that fits more than one station, for example "used for Rock/Pop;
  also fits Rock:Pop", and a picture that lost to a better fit, for example
  "not used: Rock/Pop uses Rock-Pop.png";
- a picture that no favorite or playlist station is named like ("no favorite or
  playlist station has this name"). This is only judged once your playlists
  have been read.

The list follows the last scan. It is made again when you press **Refresh**, and
it is hidden when there is nothing to report.

World Media lists the folder when it starts and again whenever you press
**Refresh**. Nothing about the pictures is stored in your settings.

#### Clear local cache

**Clear local cache** is a reset, not a thumbnail-only cleanup. It removes
favorites, favorites categories, the names you gave your favorites, preferences
(the Visualizer's choices and favorites are part of them), volume, EQ, job
history and the results of **Auto (verified)** checks from the browser profile,
empties the song log and your starred songs, and clears catalog/artwork cache
records. It keeps downloaded media, imported playlists, your station pictures,
the stations you keep on their own stream, and managed FFmpeg tools. Back up
the data directory before using it. If the saved copy in your data folder
cannot be cleared, Settings stays open and says so; press **Clear cache** again
before closing World Media.

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

### Starred songs

Star a song you want to keep: press the star on its row in the **Song log**,
or the star beside the song on the player bar while it plays. The player bar's
star shows only while the station announces something that looks like a song;
a line that is just the station's name, for example, cannot be starred, and
the log's star for it cannot be pressed (pointing at it says why). Press a
star again to unstar the song.

The **Song log** and **Starred songs** buttons at the top of the panel switch
between the two lists. **Starred songs** lists the songs you starred, newest
first, with the station and the date and time you starred each. Each song has
**Web** and **YouTube**, which search for it in your browser, **Copy** and
**Unstar**. **Save as text** writes the list into the downloads folder as
`WorldMedia-starred-songs-<date>-<time>.txt`, one song a line with its station
and date; **Save as CSV** writes a spreadsheet file of the same name ending in
`.csv`, with the columns Song, Station, Date starred and Time starred.

Up to 2,000 songs are kept. Starring one more removes the oldest, and the panel
says which. Starred songs are kept apart from the song log, in
`starred-songs.json` in the `WorldMediaWindows-data\state` folder, so **Clear
log** and the log's limit of 500 songs leave them, and they are included in
backups. **Clear local cache** empties them. A starred song keeps the station
name shown when you starred it. If the saved list cannot be read, World Media
starts a new one, says so, and keeps the old file in the same folder.

## Sleep timer

The Sleep selector offers Off, 1 minute, 15 minutes, 30 minutes, 1 hour,
2 hours, and Custom (0.1–720 minutes). Ten seconds before expiry it fades both
audio and video volume, pauses playback, restores the pre-fade volume, and
cancels itself. A volume you set with the volume control while it fades is the
one that is restored, when the timer ends or is cancelled.

## Keyboard and accessibility

Cards, sidebar rows, dialogs, the tuner dial, sliders, the volume control, and
buttons expose keyboard focus and ARIA labels. Enter/Space activates focused
cards and tuner selection; arrow keys navigate sidebar/tuner controls; Escape
closes Settings and EQ dialogs. On the volume control and on the Tuner's
**Visualizer:** control, the arrow keys change the level by 1, Page Up and Page
Down by 10, and Home and End set the lowest and the highest level. Reduced-motion and forced-colors behavior is covered by the
frontend accessibility tests.
