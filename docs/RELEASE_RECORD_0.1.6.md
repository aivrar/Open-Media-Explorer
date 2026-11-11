# v0.1.6 release verification - 2026-11-10

Release scope: three interface changes from
[issue #4](https://github.com/aivrar/Open-Media-Explorer/issues/4). Sources
switched off in Settings are left out of the Library sidebar; the Tuner dial
accepts the mouse wheel and no longer jumps when dragged across the 9 o'clock
position; and the floating video scales with the window and has a larger-size
button whose state is a saved setting (`videoSize`). It also restores the
managed FFmpeg install, whose provider moved to a new GitHub address. See
[release notes](RELEASE_NOTES_0.1.6.md).

**Republished the same day.** v0.1.6 was first published on 2026-11-10 from
commit `f92eb26` without the FFmpeg fix. A few hours later the tag was moved
and all three release files were replaced with the build recorded here. The
first upload's hashes were EXE `F2BFE7DA...B15EAC7D` and ZIP
`20FFA977...259D365A`; each file had been downloaded at most twice, including
this project's own verification download.

## What changed and why

- A disabled source stayed in the sidebar at reduced opacity with a
  "not allowed" cursor. It is now hidden, and sidebar arrow-key navigation
  skips hidden rows.
- The dial measured each drag from its starting pointer angle. `atan2` wraps
  from +180 to -180 degrees at 9 o'clock, so crossing that point read as a full
  reverse turn: 30 stations at 12 degrees each, which lands on a different
  station whenever the list is not a multiple of 30. Drags now add up the
  shortest turn between consecutive pointer positions.
- The video was fixed at 320 px wide. Its width is now one sixth of the window
  width, held between 320 px and 640 px (and at most 32% of a narrow window),
  so a 1080p-wide window is unchanged. The larger size is 40% of the window
  width, held between 480 px and 1400 px.
- The managed FFmpeg provider moved from `BtbN/FFmpeg-Builds` to
  `FFmpeg-Builds/FFmpeg-Builds` (same repository ID 292087234, same
  maintainer; GitHub redirects the old name). GitHub's API now answers with the
  new name, which the release parser rejected as "GitHub release repository
  identity is invalid", so the install in Settings failed in v0.1.2 to v0.1.5.
  The scheduled provider check caught it on 2026-11-09. The pinned repository
  is now the new name; the former name is rejected and has a test.
  Existing installs are not affected, because the manifest's recorded
  repository is not checked when an installed copy is loaded.

## Evidence

- `npm test`: 319 passing JavaScript tests (6 new in
  `tests/issue4-feedback.test.js`).
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 187 passing tests.
- `python -m ruff check --select F,E9`: clean.
- `npm run build`: succeeds with the existing dash.js warnings.
- Real-browser run (installed Edge, disposable state) against the release EXE,
  32 checks, all passing:
  - three switched-off sources absent from the sidebar, the other eight and
    the Browse/By type rows present, arrow keys skipping the hidden rows;
  - with 80 favorites on the dial: ten wheel notches move ten stations, the
    station is tuned only after the wheel rests, a drag across 9 o'clock moves
    one station, and a full clockwise turn passes exactly 30;
  - video width 320/427/640 px in 1920/2560/3840 px windows and 768/1400 px
    at the larger size; position unchanged (16 px from the right edge, 8 px
    above the player bar); the size choice saved, restored after a reload, and
    other settings untouched; nothing drawn while no video is playing.
- `tests_python/ffmpeg_real_integration.py` (real provider): release 440369099
  queried at the new address, the 194,054,566-byte archive downloaded, its
  SHA-256 digest verified, and ffmpeg and ffprobe installed and probed
  (`n8.1.3-34-ga35157abb9-20261110`).
- `tests_python/packaged_release_real_smoke.py` against the final ZIP: the
  packaged app installed managed FFmpeg through its own API, then recorded
  live audio (MP3, 17.3 s) and live video (MP4, 720p, 13.9 s) that ffprobe and
  Windows could open, and shut down cleanly with no partial files.
- Portable ZIP windowed launch gate: extracted twice into new folders, one with
  every file marked as downloaded (`ZoneId=3`); both opened a visible window
  (6.1 s and 6.3 s). All three `webview\lib\runtimes` folders are present.
- ZIP integrity: 450 entries; bundled frontend byte-identical to `frontend/`;
  no profiles, logs, or repository metadata.
- Single EXE marked as downloaded opened a visible window (4.8 s) and served
  the 0.1.6 frontend bundle and notices.
- `tests_python/playlist_release_browser_smoke.py` against the packaged EXE:
  every check passed (radio, M3U import, HLS and DASH playback, Favorites, all
  modes, save-failure warning, Shutdown, restart persistence).

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,945,146 | `C117EDA062D382CCF69B303AD22C21AD416D73EAA1EDFC39E13087BBAB7AFD3D` |
| `WorldMediaWindows-0.1.6-portable.zip` | 14,775,624 | `A47601308C532CAE0258C4CA82058DDCE2A3F53D4CBB2E4A44223615187FD2FC` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Checked on Windows 10 x64 at 100% display scaling; 4K-wide layouts were
measured in a browser window of that size, not on a 4K monitor. The video
overlay's size and position were measured with an empty video element; real
HLS and DASH playback in the overlay was covered by the packaged smoke test.
Fullscreen from the video's own controls and touchpad scrolling on the dial
were not exercised by an automated check. The v0.1.5 boundaries still apply.
