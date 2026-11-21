# v0.1.14 release verification - 2026-11-21

Release scope: one fix for a report in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6): stations
on an old Shoutcast server did not play, although their address worked in a
browser or another player. See [release notes](RELEASE_NOTES_0.1.14.md).

## What changed and why

- **The fault.** An old Shoutcast server (version 1) starts its answer to a
  player with `ICY 200 OK` where a web server says `HTTP/1.0 200 OK`. The
  header lines and the sound after that line are the same as any other
  station's. The app's connections are made with Python's `http.client`,
  which refuses a first line that does not start with `HTTP/`, so every
  request to such a server ended as "could not be reached". The three **Pick
  the best stream** settings could not change that, because each of them ends
  in the same request. Asked by a browser, such a server sends its status
  page, not the sound.
- **The fix.** The connection now reads a first line that starts with `ICY`
  and a space as `HTTP/1.0` (`_IcyStatusLineReader` and `_RelayResponse` in
  `worldmedia_media.py`). Only the first line of a reply is looked at, and
  only that exact word at its start. Every outbound connection of the app
  goes through this code, so playing, song titles, recording, downloads and
  the stream check of **Pick the best stream: Auto** all take such a server.
  The status after `ICY` is kept: `ICY 404` is still a 404.
- **Unchanged.** A first line that is neither is still refused, asked once
  more without the title request, and reported as before. A normal reply is
  read exactly as before.
- The wiki no longer says that such a station does not play
  ([Troubleshooting](wiki/06-troubleshooting.md), [Architecture and runtime
  reference](wiki/08-architecture-and-runtime-reference.md)).

## Evidence

- `npm test`: 1,666 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 621 tests,
  614 passing and 7 skipped. Four of them are new for this fix: an old
  Shoutcast reply plays byte for byte with its song title and one request; an
  `ICY 404` stays a 404; five other first lines (such as `ICYX 200 OK` and
  `icy 200 OK`) are still refused; a line starting with `ICY` later in the
  reply is left alone.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- The station from the report (Radio Caprice - Trip Hop, a Shoutcast 1.9.8
  server), on the day of the release:
  - With the v0.1.13 code the request failed with `MEDIA_CONNECT_FAILED`,
    with and without the title request.
  - With the v0.1.14 code, through the app's own server (register, then the
    relay address as the player asks for it): 200, `audio/aacp`, first reply
    after 0.5 s, about 400,000 bytes of AAC sound in 4.1 s, and the song
    title under now-playing.
  - In the real window of the release EXE, with the report's playlist entry
    imported into My Playlists: the station's card played from the Library,
    sound after 3.4 s, the time still running 9 s later, the song title in
    the player bar and on Now Playing, the sound meter lit, no "did not
    play" mark, no page errors.
- Final release files, on the test machine:
  - The one-file EXE, started without a window, answered its health check in
    3.7 s, served the page and all 131 frontend files byte for byte, answered
    403 without the session token, and exited with code 0 after shutdown.
  - The portable ZIP has 571 entries (514 files) under one top folder, no
    unsafe names, the three WebView2 loaders, 131 of 131 frontend files and
    20 of 20 server modules identical to the repository, and no user data,
    logs, downloads or tools. Its extracted copy passed the same checks as
    the EXE (health check in 3.3 s, exit code 0).
  - Started in a window with every file marked as downloaded from the
    internet: the portable folder showed its window after 5.3 s and the
    one-file EXE after 11.2 s; both exited with code 0 when the window was
    closed, with no failure lines in their logs.
  - In the real window, About and Settings read v0.1.14 and all seven tabs
    are present.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,654,217 | `FEC9011CFA62C9E2D545C07A2F15FA76AE67A52123A64C626206991AAC4D2638` |
| `WorldMediaWindows-0.1.14-portable.zip` | 15,424,131 | `9E9D2DF4C037A1302A3FBEC8DD1B1BDFF7A5A552F5B9671BCFB964579F256014` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- A station can still fail for another reason: its server is down, its
  address has changed, it refuses connections from some countries or
  players, or it sends a format the player cannot decode. A favorite or a My
  Playlists station that does not play gets the small red **!** as before.

The v0.1.13 boundaries still apply. The limit recorded since v0.1.9, that an
old Shoutcast server answering `ICY 200 OK` does not play, is gone.
