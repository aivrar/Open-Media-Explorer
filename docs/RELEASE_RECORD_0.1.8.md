# v0.1.8 release verification - 2026-11-10

Release scope: the three bugs in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) (a
one-station dial that still turned, playlist wording that named only M3U, and
a knob marker that did not line up with the station), plus layout and visual
fixes found by looking at screenshots of every screen. Frontend only: no
backend, packaging, or network changes beyond the version number. See
[release notes](RELEASE_NOTES_0.1.8.md).

## What changed and why

- With one station, the index is always 0, but arrow keys, the wheel and
  dragging still rotated the dial and called `playItem` again, restarting the
  stream. `dialCanTurn()` now stops rotation for a list of one, and
  `tuneCurrent({ restart: false })` skips a station that is already playing.
  The same check stops a click or drag release on the playing station from
  restarting it with any list length.
- The dial maps 12 degrees to one station, so a trip round a list is only a
  whole turn when the list has 30 stations. After wrapping, or after letting
  go of a drag between two stations, the knob's marker rested at an arbitrary
  angle (the report's screenshot shows station 1 of 25 with the marker at
  10 o'clock). `settleDial()` now brings the knob to `index * 12` after each
  step, wheel notch, and drag release.
- The dial was sized from the stage's width only, so a short window (about
  1280x800 with the player bar showing) cut off its top and bottom. The stage
  is now a size container and the dial is `min(540px, 78cqw, 100cqh)`. The
  station name is limited to the knob's width at any dial size.
- The decorative dot at the dial's centre sat behind the station number and
  read as a smudge; it is removed.
- The drop hint and the import button named "M3U" although `.m3u8` was always
  accepted. Wording only; the accepted types are unchanged.
- The player bar showed an empty square for items without artwork. It now
  shows the same initials and colour as the cards, behind the artwork image.
- The Local port box in Settings used the browser's default look.

## Evidence

- `npm test`: 333 passing JavaScript tests (7 new in
  `tests/issue6-dial-tweaks.test.js`).
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 187 passing tests.
- `python -m ruff check --select F,E9`: clean.
- `npm run build`: succeeds with the existing dash.js warnings.
- Real-browser run (installed Edge, disposable state) against the release EXE,
  21 checks, all passing:
  - one favorite: arrow keys, wheel and a quarter-turn drag leave the dial
    transform unchanged, the display reads "1 of 1", and playback time keeps
    advancing (no restart); an arrow key starts the station when stopped;
  - two favorites: arrow key and wheel move between stations as before;
  - 25 favorites: station 1 rests at 0 degrees, station 25 at 288; stepping
    past the end and a full trip round by wheel both end on station 1 at
    0 degrees; a drag released between stations settles exactly on the chosen
    station;
  - the drop hint names both file types, an `.m3u8` drop imports, and the
    button reads "Import playlist";
  - the player bar shows initials for an item without artwork.
- A separate run confirms real artwork still loads in the player bar and
  fills the box over the initials.
- Screenshots of Tuner (idle and playing), Library, My Playlists, Grid,
  Discovery, About and Settings at 1024x640, 1280x720/800 and 1920x1080 were
  reviewed by eye. The dial fits its stage at every size; no control is off
  screen.
- The v0.1.6 (32 checks) and v0.1.7 (27 checks) browser runs still pass
  against this EXE.
- Portable ZIP windowed launch gate: extracted twice into new folders, one with
  every file marked as downloaded (`ZoneId=3`); both opened a visible window
  (4.3 s and 4.0 s). All three `webview\lib\runtimes` folders are present.
- ZIP integrity: 450 entries; bundled frontend byte-identical to `frontend/`;
  no profiles, logs, or repository metadata.
- Single EXE marked as downloaded opened a visible window (4.8 s) and served
  the 0.1.8 frontend bundle and notices.
- `tests_python/playlist_release_browser_smoke.py` and
  `tests_python/packaged_release_real_smoke.py` against the packaged EXE:
  every check passed.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,947,120 | `1A904A78678BE19051D81860C01149D406AC58B335CBB201A7F8B296DE75E032` |
| `WorldMediaWindows-0.1.8-portable.zip` | 14,777,052 | `0C3F30890A4D1BF288FA808F3513BC2A05C3622827AEDB9E5C47983CA7B1236F` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

The dial was driven with synthetic mouse, wheel and key events in a browser,
not by hand on the native window, and not with a touchpad. How fast the dial
moves through stations while dragging (30 per turn) is unchanged; the report
also called the dial "twitchy", and only the resting position was addressed.
One run of the browser check timed out waiting for the public test stream to
start and passed on rerun. `.pls` and `.xspf` playlists, starring a whole
playlist, custom station images, dial hover highlighting, strip looping, and
the higher-quality stream search (all requested in issue #6) are not part of
this release. The v0.1.7 boundaries still apply.
