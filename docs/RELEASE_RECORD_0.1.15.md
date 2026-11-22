# v0.1.15 release verification - 2026-11-21

Release scope: channels, stations and episodes load faster and keep loading
through a poor connection; more podcast episodes and recordings are listed
and play; new screenshots in the README and the wiki. See [release
notes](RELEASE_NOTES_0.1.15.md).

## What changed and why

- **Radio Browser asked for 30 stations per request.** The Library reads the
  directory page by page, one request after another, so a directory of tens
  of thousands of stations filled in slowly. It now asks for 300 per request
  (`BROWSE_BLOCK` in `src/adapters/radio-browser.js`). The mirrors are checked
  at the same time, and a mirror that failed is left out.
- **Lists were sent uncompressed.** The local server now asks the catalog
  providers for gzip and passes the compressed answer to the page. The three
  iptv-org files of the TV list are 2.5 MB on the wire where they were
  17.9 MB. The channel pictures of that list are fetched beside it, and the
  channels wait for them at most six seconds. The list is read again after
  six hours.
- **A server's addresses were tried one after another.** A host name can
  resolve to several addresses. The connection tried each in turn with the
  full eight-second time limit, so a host whose first address was dead cost
  eight seconds for every request and every redirect. `_connect_first` in
  `worldmedia_media.py` now tries the validated addresses together: IPv4
  first, the next address a quarter of a second later (at once when an
  attempt fails outright), the first that connects is used and the others are
  closed, all inside one time limit. The address that answered is tried first
  for that host for ten minutes. No address is tried that the lookup and its
  public-address check did not allow.
- **Requests queued inside the embedded browser.** The browser gives the
  local server six connections, shared by lists, pictures and the playing
  stream, and a queued request's time limit ran while it waited. Catalog
  requests now pass a gate of four at a time (`src/lib/http.js`), and the time
  limit starts when a request is sent. LibriVox pages are asked for without
  the extended details (0.4 s a page where it was 1.1 s).
- **A source that failed stayed failed.** A Library source that fails twice
  in a row is now asked again after one minute, then two, four and eight,
  then every ten minutes, and its page says that it is not answering, with
  **Retry now**. `src/modes/library/line-watch.js` notices that the
  connection is back after a drop and wakes the waiting sources. In the Tuner
  and the Grid a source that could not be loaded is tried again after 15
  seconds, a minute, then every five minutes, and at once when the connection
  is back (`src/lib/live-load.js`). A podcast feed that fails for a passing
  reason is tried again up to three times. A NASA page that comes back short
  is asked for again instead of ending the list.
- **Owncast and the media.ccc.de live rooms stayed at 0.** A live list was
  first fetched only while a Library view that includes it was open, so with
  the Library opened on Favorites, Radio or My Playlists nothing was fetched.
  The first fetch now happens at start whichever view is open, and its
  retries do not wait for such a view (`src/modes/library/snapshots.js`,
  `chain.js`). The regular refresh still runs only while the list is shown.
- **Podcast episodes in other formats were dropped.** An episode was listed
  only for MP3, MP4 or HLS. M4A and AAC, Ogg Vorbis, Opus, FLAC, WAV, WebM,
  M4V and MOV are now accepted (`worldmedia_catalog.py`,
  `src/adapters/gpodder.js`). An episode that offers several files plays the
  one it played before. Ogg Theora, HEVC and MKV are still left out, also
  when the codec is named inside the file type. Feeds up to 4 MiB compressed,
  16 MiB decoded and 250,000 elements are read, and a feed with an
  `<?xml-stylesheet ?>` line is accepted.
- **Picks of the file to play.** media.ccc.de: MP4, MP3, WebM, then Opus, in
  the talk's own language first, then a recording that carries several
  languages, then another language. Internet Archive: an Ogg Theora or Opus
  derivative is used only when nothing else plays. Wikimedia Commons: FLAC
  and Opus are listed. Radio Browser: a station without a resolved address
  uses its listed address. LibriVox: a feed with no MP3 plays its first sound
  file.
- **Downloads of sound labelled as video.** A download whose server sends
  `video/mp4`, `video/quicktime`, `video/webm` or `video/ogg` for a sound
  file is accepted when the name ends as that kind of sound file does and the
  file begins with that container's signature (`worldmedia_downloads.py`);
  it keeps its own file ending.
- **Screenshots.** `screenshots/v0.1.14/` holds 25 new screenshots and four
  GIF demos used by the README and the wiki; the older screenshots are
  removed.

## Evidence

- `npm test`: 1,734 passing JavaScript tests (68 more than v0.1.14).
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 655 tests,
  648 passing and 7 skipped (34 more than v0.1.14). The new ones cover the
  connection to a host with several addresses, the podcast formats, the
  downloads labelled as video, the retry rules of the Library, the Tuner and
  the Grid, the limit of four requests, and the picks of each source.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Loading, in the real window on the test connection:
  - Radio Browser: 14,700 stations in 104 seconds; v0.1.14 collected about
    690 in the same time. Each request of 300 stations took 1.4 to 2.1
    seconds.
  - A cold start of the release EXE, 63 seconds: 31,586 items from the ten
    sources, the TV list complete (12,805 channels), 9,300 radio stations,
    Owncast with 75 streams, and no failed request to
    Radio Browser, iptv-org, the Internet Archive, LibriVox, media.ccc.de,
    PeerTube or Owncast.
  - With the Library opened on Favorites, Owncast showed its 75 streams
    within three seconds of the start.
  - A podcast host with one dead address: a request that took 17.5 seconds
    takes 1.4 to 1.6 seconds, and an episode on it starts in about seven
    seconds where it did not start within a minute.
- A dropout, in the real window of the release EXE: every outside request
  was made to fail for two minutes. The sources showed **Wait** and the page
  said that they were not answering. After the requests worked again, each
  of the six sources that were still collecting had new items within 10 to
  18 seconds without a click.
- Formats, in the real window of the release EXE: an M4A file and an Opus
  file played; a radio station played within six seconds; a media.ccc.de talk
  with recordings in several languages played as 1920x1080 video; an episode
  of a podcast that publishes only Ogg files was listed, and its download
  saved 18,015,705 bytes as a valid Ogg Vorbis file ending in `.ogg`.
- Screens: the seven tabs and Settings were looked at as screenshots at
  1024x640, 1280x800 and 1920x1080.
- Final release files, on the test machine:
  - The one-file EXE, started without a window, answered its health check in
    3.9 s, served the page and all 131 frontend files byte for byte, answered
    403 without the session token, and exited with code 0 after shutdown.
  - The portable ZIP has 571 entries (514 files) under one top folder, no
    unsafe names, the three WebView2 loaders, 131 of 131 frontend files and
    20 of 20 server modules identical to the repository, and no user data,
    logs, downloads or tools. Its extracted copy passed the same checks as
    the EXE (health check in 2.3 s, exit code 0).
  - Started in a window with every file marked as downloaded from the
    internet: the portable folder showed its window after 4.1 s and the
    one-file EXE after 5.0 s; both exited with code 0 when the window was
    closed.
  - In the real window, About and Settings read v0.1.15 and all seven tabs
    are present.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,669,031 | `F86CB302C93F0467CC7EAF97D7EFACEB71F6846AA76AD8DD83C4E8D8227A15A0` |
| `WorldMediaWindows-0.1.15-portable.zip` | 15,435,092 | `86A13A6AAD43D95CE64623539BBE0D903879EA1FB62CBB38006DA051C3A3E7E4` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- How fast a list fills still depends on the provider and the connection.
  The figures above are from one connection on one day.
- Browsing the podcast source covers the directory's top 100 shows and the
  14 newest episodes of each; a search covers eight shows with five episodes
  each. The Tuner takes up to 80 stations and the Grid up to 100 from each
  source.
- A LibriVox book, and an Internet Archive item made of several sound files,
  plays its first file.
- A file whose publisher has removed it cannot be played or downloaded; the
  download then ends with "The media source rejected the download."
- Podcast episodes published only as Ogg Theora, HEVC or MKV are not listed.

The v0.1.14 boundaries still apply.
