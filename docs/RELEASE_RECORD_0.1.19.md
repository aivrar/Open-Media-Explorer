# v0.1.19 release verification - 2026-11-27

The Computer tab plays music, films, shows and audiobooks from folders you
add. See the [release notes](RELEASE_NOTES_0.1.19.md).

## What changed and why

- **Computer.** Add folders, then browse music by album, artist, song, genre
  or folder, video by movie, show or folder, and audiobooks with chapters
  when available. Star favorites and find your files through Library search.
  Offline folders stay in the list, and files keep their stars after a move
  when the app can match them.
- **Playback.** Formats the built-in player cannot play are converted on
  the fly, including DVD files. Choose subtitles and sound tracks in the
  player bar. Volume levelling evens out music, and the next song of an
  album is prepared for a gapless start.
- **Tabs.** Grid and Discovery were removed. Library covers the live
  stations, and **Surprise me** in **Now Playing** plays a random pick.
- **Issue #6.** Playlist import follows linked channel lists. Text fields
  have a right-click editing menu. The first backup can become the main
  stream address, and changing the backups keeps the saved format and
  quality. Stations with the same name keep their own pictures. The video
  controls are clear of the dark blur. Library keeps its place when filters
  are cleared or a card opens, counts matches and accepts language names and
  codes, including for iptv-org TV. The Tuner list stays put when a station
  in view is clicked. A saved station that sends no stream tries its
  backups and shows a failed-start mark if none play.

## Evidence

- `npm test` reported 2,254 passing JavaScript tests. Python unit tests
  reported 1,029 passing tests and 14 skips.
- In the application window, the Computer tab's views were checked at
  1024 x 640, 1100 x 700 and 1280 x 800. A generated library of 50,000 files
  took about one minute to scan the first time. Views opened in at most
  0.3 s, and memory stayed steady over thirty rounds of switching, scrolling
  and searching. A music folder of about 10,000 files scanned in under 40 s,
  and 150 album covers took about 10 s to load.
- Playback in the window was checked. Gapless album boundaries were 5 to
  8 ms. Converted films and DVD files were checked for seeking, sound-track
  choice and subtitles from the file and from files beside it. Volume
  levelling changes glided without a jump. At rest after every kind of
  playback, processor use was under 1 % of one core.
- An offline folder, moved files, **Locate...**, and a restart with the
  large library were checked.
- **Issue #6.** A playlist linked to a list of 181 channels and imported all
  of them. Right-click paste in text fields, backup address promotion and a
  same-named TV channel keeping its own picture were checked. Library kept
  its position through filtering to within a pixel, and the filter count
  was checked. All 30 Tuner list clicks left the list in place.
- The release EXE and the extracted portable ZIP: each was started with every file marked as downloaded from the internet. The start page, the health check, the token check and the third-party notices passed, the window opened, and each closed with exit code 0.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 20,115,581 | `CE42BA01AB1ABABCA9E4D1993E56682A4127707E15A82554E52267C789FA08B7` |
| `WorldMediaWindows-0.1.19-portable.zip` | 15,687,150 | `DDFFCFAE99F7D60FA95BDE31F8A498289965615CFDB354B248BDA7E0A7FDA76B` |

## Boundaries

- Picture-based DVD subtitles are unavailable.
- A film that needs converting takes a moment to start.
- Files in your own folders stay outside My Playlists.
- The four Visualizer scenes held back in 0.1.18 remain held back.
