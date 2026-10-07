# Using the application

My Playlists, Add link, and Favorites media/local-search filters require v0.1.3
or newer.

## Window layout

The top bar is shared by every mode:

- **World Media** opens the current view.
- **Library**, **Tuner**, **Grid**, **Discovery**, and **About** switch modes.
- The **Sleep** control starts or cancels the sleep timer.
- The gear opens **Settings**.
- **Shutdown** asks the local runtime to stop catalog workers, artwork, media,
  downloads, recording, and FFmpeg work before the process exits.

The bottom player bar is global. It survives mode switches, so you can start a
station in Library, inspect Grid, and return without losing the current player.
Video appears in a movable overlay above the bar; audio keeps the bar visible
without showing a video element.

## Library

Library is the main browse and search surface.

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
  Its **All media / Radio / TV / Video / Audio** selector filters only favorites.
  Its search box searches saved titles, descriptions, and groups locally, without
  sending a provider search. This search and type choice are kept separate from
  public-catalog filters during the session. Country/language/year filters still apply.
- **Browse → My Playlists** opens imported channel lists and direct links.
- **By Type** selects Radio, TV, Video, or Audio.
- **By Archive** selects one of the eleven source adapters.

The number beside a row is the session count for the selected catalog (or the
persisted favorite count). The status word beside a source is a compact health
indicator:

| Label | Meaning |
|---|---|
| **Pull** | More catalog work is available or being scheduled. |
| **Sync** | A live snapshot is being refreshed. |
| **Live** | The source has a current live snapshot. |
| **Wait** | The source is rate limited or retrying after an error. |
| **Stale** | A prior live snapshot is still shown while refresh retries. |
| **Done** | A finite cursor reached an authoritative end. |
| **Off** | The source is disabled in Settings. |

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
   or DASH `.mpd`). Choose **Online M3U playlist** to fetch a list of channels.
   To use a local file instead, click **Import M3U** and select the file.
4. Choose that playlist (or **All playlists**), search titles/groups, or filter by
   media type. Click a channel to play; star it to save it in Favorites.

Import supports UTF-8 and legacy Windows-1252 text, `#EXTINF` names, `tvg-name`,
`tvg-logo`, `tvg-country`, `tvg-language`, `group-title`, `#EXTGRP`, and `radio`
metadata. Audio filename extensions are recognized when no explicit `radio`
attribute is present. VLC-style HTTP referrer/user-agent options are accepted
when safe. Local file entries must be absolute HTTP(S) URLs; relative stream and
logo URLs in online playlists resolve against the playlist's final URL after
redirects. Unsupported entries and
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
cards wait for the viewport. A missing logo leaves a source-branded placeholder
and can be retried without affecting the catalog item.

Click the card body to open its detail panel and start playback. The panel can
show:

- title and description;
- source, country, language, tags, year, and license;
- **Play** or **Try next** behavior for live candidates;
- **Download** when a finite original is available;
- **Record audio/video** when the item is live and FFmpeg is ready;
- a link to the provider's **Source** page.

Click the star on a card, detail panel, or player bar to add/remove a favorite.
Favorites retain stable item identity and favorite-scoped EQ. Short-lived local
artwork and media relay URLs are deliberately removed before persistence and
resolved again on a later launch.

## Grid

Grid is a live guide. Choose **Live TV** or **Radio**, then optionally filter by
category, country, source, and the text **Filter…** box. The built-in category
list includes News, Music, Sports, Movies, Documentary, Kids, Entertainment,
and Education.

Click a tile or press Enter/Space while it is focused to play it. Tile logos are
viewport hydrated, so the first visible rows load before far-away rows. The Grid
and Library share the same artwork relay and playback priority rules.

Grid does not host channels or manufacture schedules. IPTV, Owncast, PeerTube,
Radio Browser, gPodder live entries, and C3VOC contribute whatever public live
items they report at refresh time.

## Tuner

Tuner provides a radio-style way to step through live media:

1. Choose **Radio** or **TV**.
2. Filter by country and source.
3. Drag the dial, use Left/Up or Right/Down, or focus the dial and use arrow
   keys.
4. Press Enter or Space to play the selected item.

The MHz/CH number is cosmetic navigation feedback. It is not a promise that a
station broadcasts on that terrestrial frequency. Tuner reuses the live
adapter/snapshot lane and content-rating preference.

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

About is a static reference page. It lists the eleven sources, their media types,
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

The native caption bar mirrors the selected palette when Windows permits it.

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

**Clear local cache** is a reset, not a thumbnail-only cleanup. It removes
favorites, preferences, volume, EQ, and job history from the browser profile and
clears catalog/artwork cache records. It keeps downloaded media and managed
FFmpeg tools. Back up the data directory before using it.

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
