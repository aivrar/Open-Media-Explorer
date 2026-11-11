# v0.1.7 release verification - 2026-11-10

Release scope: three fixes from
[issue #5](https://github.com/aivrar/Open-Media-Explorer/issues/5). A local
M3U file dropped on the window is imported instead of being opened by Windows;
radio and audio items whose stream carries no picture no longer open the
floating video; and the Tuner's station strip keeps the current station in
view. One small follow-up to v0.1.6 hides the "By archive" heading when every
source is switched off. No backend, packaging, or network changes beyond the
version number. See [release notes](RELEASE_NOTES_0.1.7.md).

## What changed and why

- The page had no drag-and-drop handlers, so the WebView treated a dropped
  file as something to open and Windows launched its default program (Notepad
  for `.m3u`). `src/lib/playlist-drop.js` now handles every file drag: a
  `.m3u`/`.m3u8` file goes through the same import path as **Import M3U**
  (same size limit, same replace confirmation, same messages) and opens
  Library on My Playlists; any other file is ignored with a short message.
  Drags that carry no files (text, links) are left alone.
- HLS and DASH always play through the `<video>` element, and the player
  showed the floating video for every such stream, including audio-only radio.
  Radio and audio items now start with it hidden and reveal it only when the
  element reports a picture (`loadedmetadata` or `resize` with a non-zero
  size). TV and video items show it at once as before, and the picture check
  can only reveal the video, never hide it.
- The station strip is rebuilt on each station change with up to 31 stations,
  wider than most windows, and its scroll position was never moved, so the
  highlighted station was often off screen. It is now centred after each
  rebuild.

## Evidence

- `npm test`: 326 passing JavaScript tests (7 new in
  `tests/issue5-tuner-bugs.test.js`).
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 187 passing tests.
- `python -m ruff check --select F,E9`: clean.
- `npm run build`: succeeds with the existing dash.js warnings.
- Real-browser run (installed Edge, disposable state) against the release EXE,
  27 checks, all passing:
  - with 80 favorites on the dial, stations 1, 41, 80 and 79 (reached by wheel
    and arrow key) are highlighted inside the strip, and a mid-list station
    sits in the middle of it;
  - a synthetic file drag shows the hint; dropping an `.m3u` on the Tuner is
    handled by the page, opens Library on My Playlists, imports both stations
    as radio, and names the playlist after the file; a drop in the Library and
    on the Grid works the same; dropping the same file again asks before
    replacing; a `.png` is handled, explained, and not imported;
  - a real audio-only HLS stream saved as radio plays (through the video
    element) with the video hidden and no reserved space; a radio item whose
    HLS stream has a picture still gets the video; a TV item shows it and keeps
    it while playing; Stop hides it.
- The v0.1.6 browser run (32 checks: sidebar, dial, video size) still passes
  against this EXE.
- Portable ZIP windowed launch gate: extracted twice into new folders, one with
  every file marked as downloaded (`ZoneId=3`); both opened a visible window
  (6.7 s and 4.8 s). All three `webview\lib\runtimes` folders are present.
- ZIP integrity: 450 entries; bundled frontend byte-identical to `frontend/`;
  no profiles, logs, or repository metadata.
- Single EXE marked as downloaded opened a visible window (5.1 s) and served
  the 0.1.7 frontend bundle and notices.
- `tests_python/playlist_release_browser_smoke.py` against the packaged EXE:
  every check passed (radio, M3U import, HLS and DASH playback, Favorites, all
  modes, save-failure warning, Shutdown, restart persistence).

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,945,965 | `46E85E3E130E04409E9AD28D541C06F0DD5ABD2CC924978B07B4B39D7F2599FC` |
| `WorldMediaWindows-0.1.7-portable.zip` | 14,776,719 | `4F4888DDBB6DEBD0E15535077B676E39CBFFC0B51967397FC3E7E364BC6F4BE0` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

File drops were exercised with synthetic drag events in a browser, which
proves the page handles and cancels them. A drop from Windows Explorer onto
the native window was not automated. The station from the report ("RTL",
1 of 80) was not identified; the audio-only case was reproduced with a public
audio-only HLS test stream. An audio-only stream saved as TV or video still
shows an empty video, as before. Showing the current song and saving songs to
a list (also requested in issue #5) are not part of this release. The v0.1.6
boundaries still apply.
