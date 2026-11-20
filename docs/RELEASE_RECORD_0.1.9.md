# v0.1.9 release verification - 2026-11-15

Release scope: the feature requests in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
(favorites type buttons, sorting and categories, "Star all", `.pls` and `.xspf`
import, mute icon and volume percentage, dial glow, centred station cards, song
title and song log, stream quality and "Other streams", custom station images,
and a backup ZIP), automatic reconnect for live streams, the removal of the
Library of Congress source, and Library, player-bar and relay fixes found while
testing. Frontend and backend both changed. See
[release notes](RELEASE_NOTES_0.1.9.md).

## What changed and why

- Favorites: the media type drop-down became a button row. A sort choice
  ("My order" / "A-Z") is stored inside the existing settings, and move buttons
  reorder the stored list, so the Tuner follows the same order. Categories are
  kept in their own store (`worldmedia.favgroups.v1`) so that rewriting a
  favorite never drops its category.
- v0.1.8 and older treat a `profile-preferences.json` that holds an unknown key
  as unreadable and ignore all of it. New data therefore goes into
  `state/profile-preferences-extra.json`, `state/song-log.json` and the
  `station-images` folder, and the main file keeps only the keys every version
  knows. Profile saves carry a writer id and sequence number so that a late
  older save cannot overwrite a newer one from the same page.
- Playlists: `.pls` and `.xspf` are converted to M3U on import. XSPF is parsed
  as a stream with DTDs and entity declarations refused.
- Song title: the local relay asks Shoutcast/Icecast stations for metadata
  (`Icy-MetaData: 1`), removes the metadata blocks from the audio before the
  player gets it, and exposes the latest title per media token. It asks only on
  a first request, strips only a plain `200` reply with a valid `icy-metaint`,
  and retries once without the header when a station does not accept it. On
  that path audio is forwarded as it arrives, so a low-bitrate station starts
  as fast as before. Recording never asks for metadata.
- Song log: stored by the backend with revisions; an unreadable file is moved
  aside, never overwritten. CSV export guards cells that start with `=`, `+`,
  `-` or `@`.
- Stream quality: the Radio Browser adapter keeps bitrate, codec and HLS flag.
  "Other streams" makes one name search per use and matches on the same
  normalised name and the same homepage host. Nothing switches automatically.
- Station images: files in `station-images` are matched by normalised station
  name, validated with the same strict image check as remote artwork (SVG stays
  blocked), and served by id only to the app's own page with the session token.
- Backup: one ZIP in the downloads folder with the saved state files, station
  images, and `.m3u8` exports rebuilt from parsed entries. Old download history
  and `launcher.json` are left out.
- Live streams: a reconnect tier retries for up to ten minutes; a stall
  watchdog restarts a plain live stream whose playhead has not moved for 20
  seconds.
- Library of Congress: loc.gov answers every request from the app with a
  browser check (HTTP 403). The app does not try to get around it; the source
  was removed and only its name is kept so that old favorites still list.
- Library: a background browse no longer overwrites a finished search status;
  choosing one source no longer restarts every source's first page; sources in
  a provider-declared wait are kept in that wait by Retry now and by the
  explicit-content switch.
- Relay: HLS and DASH rewrites register all-or-nothing; relays left by a
  rejected download or recording start, or by a page reload, are released.

## Evidence

- `npm test`: 651 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 466 passing
  tests, 4 skipped (3 need symlink permission).
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Final release files, reduced gate (installed Edge, disposable state):
  - headless single EXE: `/`, `/api/health`, `/api/v1/session`, authenticated
    runtime status and the 0.1.9 notices; all 17 frontend files served
    byte-identical to `frontend/`; About and Settings show v0.1.9; clean
    authenticated shutdown;
  - portable ZIP windowed launch gate: extracted into new folders, one with
    every file marked as downloaded (`ZoneId=3`); both opened a visible window
    (9.2 s and 6.9 s); all three `webview\lib\runtimes` folders are present;
  - single EXE marked as downloaded opened a visible window (8.1 s);
  - ZIP integrity: 453 entries (396 files); bundled frontend and all 16
    `worldmedia_*.py` modules byte-identical to the repository; no profiles,
    state, logs, downloads, tools, tests or repository metadata;
  - `tests_python/playlist_release_browser_smoke.py`: 11 of 11 checks;
  - feature smoke on both the single EXE (26 checks) and an extracted ZIP
    (27 checks): song title and song-log row from a real station, categories,
    backup ZIP contents, and the Radio Browser quality label.
- Full gate on the build before the last text change (the only difference is
  one sentence on the About page): the same gates, plus
  `tests_python/packaged_release_real_smoke.py` (managed FFmpeg install, HLS
  probe, finite download, MP3 and MP4 recording, shutdown), `.pls` and `.xspf`
  import, station picture, "Other streams", and an upgrade and rollback run
  with the released v0.1.8 EXE on the same data folder: v0.1.9 kept the v0.1.8
  favorites and settings, v0.1.8 kept them after going back, and v0.1.9 still
  had its categories and song log on return.
- Song title against 46 real radio stations: the same 44 play in v0.1.8-era
  and new builds; 44 of 44 read through the relay with no broken audio frame
  and no metadata text left in the audio; 33 of the 40 stations that offer
  metadata showed a title and the other 7 sent an empty or placeholder title.
  Time to first sound is no slower than before on the nine stations measured.
  A 20-minute listen had no stall and no drift.
- Screenshots of Tuner (idle and playing), Library (All Sources, Favorites with
  categories and the card menu, My Playlists, a radio detail panel with "Other
  streams"), Grid, Discovery, About, Settings, the song log and the in-app
  video square at 1024x640, 1280x800 and 1920x1080 were reviewed by eye. No
  control is off screen and nothing overlaps.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,052,592 | `C67E93C29B39B4D75B195D0B70C5F00AFBF5ECA104707DDDE2C4DC312285D505` |
| `WorldMediaWindows-0.1.9-portable.zip` | 14,843,945 | `29442B40151D6CFCF90E87B8CDA7516A20D77391EF38859AD38211ECC347EB17` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`). The
signing certificate's own end date (2026-06-12) has passed; Windows reports the
signature as valid because it carries a timestamp from before that date.

## Boundaries

The page was driven in installed Edge with synthetic input against the real
packaged backend. The native window was checked for opening, closing and
process cleanup.

Known limits in this release:

- Song titles come from plain Shoutcast/Icecast streams only. HLS radio shows
  none. Some stations send jingles or filler text, which is shown as sent. Old
  servers that answer `ICY 200 OK` do not play (as before).
- A stream listed under "Other streams" can be dead at its provider.
- There is no restore button for the backup; restoring is a manual copy.
- The first play right after a fresh start can take several seconds or fail
  once while the catalogs are loading; seen in older builds too.
- With a Radio Browser view open, the Library keeps loading the directory in
  the background until it is complete, as in v0.1.8.
- A code review of the station-images feature raised points that were not
  changed: races that need a second program rewriting folders inside the
  user's own data folder at the right moment, and a crafted file that passes
  the GIF check (it is served only as `image/gif` with `nosniff`). Profile
  saves from two pages of the same data folder at once are ordered per page,
  not across pages.
- Present in v0.1.8 as well and not changed: the progress and volume tracks
  are hard to see in the Light theme, the "Clear cache" button wraps to two
  lines, and two Settings switches are narrower than the others.

The v0.1.8 boundaries still apply.
