# Data, cache, and portability

## Runtime layout

For a normal portable launch, the executable's directory is the portable root:

```text
WorldMediaWindows.exe
WorldMediaWindows-data\
  cache\                 catalog/provider cache records
  state\                 launcher.json and profile-preferences.json
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

The browser profile stores:

- favorites (`worldmedia.favorites.v1`);
- settings and enabled sources (`worldmedia.settings.v1`);
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

Older `%LOCALAPPDATA%\\WorldMediaWindows` state can be migrated once when no
portable state directory exists. The legacy source is copied, not deleted.

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

Settings → Storage → **Clear local cache** removes local favorites, preferences,
EQ, volume, and job history as well as catalog/artwork cache records. It keeps:

- files already in `downloads`;
- managed FFmpeg tools;
- the EXE and source code.

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
