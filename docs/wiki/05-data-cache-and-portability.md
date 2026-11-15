# Data, cache, and portability

## Runtime layout

For a normal portable launch, the executable's directory is the portable root:

```text
WorldMediaWindows.exe
WorldMediaWindows-data\
  cache\                 catalog/provider cache records
  state\                 launcher.json, profile-preferences.json,
                         profile-preferences-extra.json, playlists.json,
                         song-log.json
  station-images\        your own station pictures (made when you open it)
  logs\                  native.log and runtime diagnostics
  webview2_data\         WebView2 browser profile and localStorage
downloads\               finite downloads and completed recordings
tools\ffmpeg\           managed portable FFmpeg (if selected)
frontend\                 packaged UI assets in the folder build
```

The classic one-file EXE may unpack temporary startup files under Windows' temp
directory, but persistent state remains beside the EXE. The local server binds
only to `127.0.0.1`; it does not create a network-facing service.

## What is persisted

Version 0.1.3 and newer store imported M3U channel lists and direct links in
`state/playlists.json`. This is user data, not catalog cache: clearing local or
provider caches does not remove playlists. Remove a list from **My Playlists**
instead. The file follows the portable folder across moves and port changes.
Playlist URLs and optional headers are stored as plain text and can contain
provider tokens. Keep this file and the original playlists private; do not
include them in bug reports or GitHub commits.

Version 0.1.9 adds three more kinds of saved data:

- the **song log** is stored in `state/song-log.json`, not in the browser
  profile;
- **favorites categories** are saved in the browser profile under their own key
  (`worldmedia.favgroups.v1`) and mirrored to
  `state/profile-preferences-extra.json`;
- your **station pictures** are ordinary files in the `station-images` folder
  of the data folder.

These live in separate files on purpose. World Media 0.1.8 and older treat a
`profile-preferences.json` that holds a key they do not know as unreadable and
ignore all of it, favorites included. So `profile-preferences.json` keeps only
the keys that every version knows, and the newer data goes into the extra file
and `song-log.json`, which older versions never open. See **Going back to an
older version** below.

The browser profile stores:

- favorites (`worldmedia.favorites.v1`);
- favorites categories (`worldmedia.favgroups.v1`);
- settings, enabled sources, and the Favorites sort choice
  (`worldmedia.settings.v1`);
- volume (`worldmedia.volume.v1`);
- recent capture job history (`worldmedia.jobs.v1`);
- global/favorite/custom EQ (`worldmedia.eq.v1`).

Short-lived artwork and playback relay IDs are not persisted as usable URLs.
They are re-resolved from stable adapter metadata at the next launch. Live
snapshot stream URLs are also revalidated instead of being trusted indefinitely.

## Favorites backup and migration

To back up the complete user profile, close World Media and copy the entire
`WorldMediaWindows-data` directory to a safe location. Copying the whole
directory preserves the WebView2 origin and avoids losing favorites when the
EXE or localhost port changes.

To move the app from C: to E:

1. Shut down the old app and wait for its process to exit.
2. Copy the EXE/folder and `WorldMediaWindows-data` together to the new drive.
3. Launch the copy once. The app uses the adjacent data directory.
4. Confirm Favorites and Settings before deleting the old copy.

If the app is moving to a different localhost port, Settings first writes a
bounded `profile-preferences.json` handoff containing only the allowed browser
keys. The next launch restores those keys under the new origin. This is safer
than copying arbitrary browser storage, but a full data-directory copy remains
the best backup.

If Favorites cannot be saved, the app leaves the previous list/star state intact
and displays a warning. Retry after checking free disk space; never delete your
profile to clear the warning. Settings-save failures are also reported.
The native cross-port backup has a 2 MiB raw-value safety limit. If backup fails
or exceeds that limit, a warning asks you to keep the same port and make a full
data-folder backup. A manual port change refuses an incomplete backup. Favorites
are still stored in WebView2, not a separate unlimited native favorites database.

Older `%LOCALAPPDATA%\\WorldMediaWindows` state can be migrated once when no
portable state directory exists. The legacy source is copied, not deleted.

## The backup ZIP

**Settings → Storage → Back up my data** writes one ZIP into the `downloads`
folder, named like `WorldMedia-backup-20261114-221500.zip`. World Media first
saves your latest favorites and settings to the data folder; if that fails, no
backup is made. The ZIP is a copy of the saved data, not of the whole data
folder:

- `WorldMediaWindows-data\state\` holds `playlists.json`,
  `profile-preferences.json` (favorites, settings, volume, equalizer curves),
  `profile-preferences-extra.json` (categories) and `song-log.json`, for each
  of them that exists;
- `WorldMediaWindows-data\station-images\` holds your station pictures;
- `exports\` holds `.m3u8` playlist files that other players can open:
  `favorites-radio.m3u8`, `favorites-tv.m3u8`, `favorites-other.m3u8`, and one
  file for each imported playlist;
- `README.txt` explains the files and how to restore them.

The cache, logs, browser profile, FFmpeg tools, and your downloads are never
included, and old download history is left out of the copy. Everything in one
ZIP is limited to 192 MB before compression; the README in the ZIP says if
some station pictures did not fit.

**There is no restore button.** To restore, close World Media, copy the
`WorldMediaWindows-data` folder from the ZIP into the folder that holds
`WorldMediaWindows.exe`, and let it replace files with the same names.
Imported playlists come back at once. Favorites and settings are only taken
from the backup by a copy of World Media that has none of its own yet, such as
a new computer or a fresh copy of the app. Copying the entire
`WorldMediaWindows-data` folder remains the most complete backup.

Playlist addresses can contain private links or account tokens, so share the
ZIP only with people you trust.

## Station images

The `station-images` folder inside `WorldMediaWindows-data` holds your own
pictures for stations. **Settings → Station images → Open folder** makes the
folder and opens it. A picture named like a station, for example
`Radio Paradise.png`, replaces that station's artwork after you press
**Refresh**. PNG, JPG, WebP or GIF, up to 2 MB each. World Media only reads
this folder. Because it is part of the data folder, it moves with the portable
folder, and the backup ZIP includes it. **Clear local cache** leaves it alone.
[Using the application](02-using-the-application.md) has the matching rules.

## Going back to an older version

Keep the `WorldMediaWindows-data` folder as it is and start the older EXE
beside it. Going back from v0.1.9 to v0.1.8 keeps your favorites and settings,
because the data that v0.1.8 does not know is kept in other files (see above).
v0.1.8 does not show favorites categories, the song log, or station pictures,
and it does not open or change those files. It also ignores the Favorites sort
choice. Back up the data folder before you switch, as for any update.

## Cache semantics

Provider metadata cache records are bounded (256 total/64 per provider, 2 MiB
per entry, 64 MiB total). Artwork registrations expire after six hours and use
a separate bounded registry. Cache improves repeat browsing; it is not a
negative catalog filter. A cached item does not tell an upstream API to omit
that item forever. The adapter still advances its cursor/snapshot and merges
new identities.

The Library's complete session pool is separate from the provider cache. The
render window can show 300 cards at once while the resident session pool keeps
all accepted unique items. Scrolling, filtering, or using a source tab does not
discard unseen collected items.

## Clearing cache safely

Settings → Storage → **Clear local cache** removes local favorites, favorites
categories, preferences, EQ, volume, and job history, empties the song log, and
clears catalog/artwork cache records. It keeps:

- files already in `downloads`, including backup ZIPs;
- imported playlists (`state/playlists.json`);
- your station pictures;
- managed FFmpeg tools;
- the EXE and source code.

If the saved copy in the data folder cannot be cleared, Settings says so and
stays open. Press **Clear cache** again before closing World Media, or the
favorites and settings could come back.

Treat this as a profile reset. Back up the data directory first if favorites or
custom EQ matter. Do not delete individual WebView2 files while the app is
running.

## Read-only folders and FFmpeg destinations

The runtime probes download and tool directories before enabling capture. A
read-only portable folder cannot publish downloads. Settings explicitly shows
the condition and lets you choose **LocalAppData** for managed FFmpeg tools;
this does not silently move your finite media downloads. Choose a writable
portable root (for example a normal user-owned folder) when you want a fully
portable test copy.

## Test portable profile

This repository's dedicated test launcher is:

```text
E:\WorldMediaWindows\dist\PortableTest\WorldMediaWindows.exe
```

Its data is:

```text
E:\WorldMediaWindows\dist\PortableTest\WorldMediaWindows-data\
```

Keep that profile separate from development and release data. Never overwrite
or delete it merely to rebuild the EXE; copy a newly built executable over the
launcher only after the process has exited, and verify Favorites afterward.
