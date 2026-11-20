# v0.1.10 release verification - 2026-11-16

Release scope: the bugs reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) (custom
station pictures cut off, and three ways the Tuner dial changed size) and three
requests from
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
(a sound meter in the player bar, the knob text without the source name, and a
Tuner card size with station pictures). Only the frontend changed; the Python
backend is unchanged apart from the version strings, and one Python relay test
was made steadier. See [release notes](RELEASE_NOTES_0.1.10.md).

## What changed and why

- Station pictures: the player bar and the detail panel filled their box with
  `object-fit: cover`, so a picture that was not square lost its sides or its
  top and bottom. `artwork.js` and the player bar now put an
  `is-station-image` class on an image only once a user's station picture has
  loaded into it (and take it off when the image starts loading something
  else, fails or is emptied). The player bar, Library cards, detail panel,
  Discovery and Tuner cards show such an image with `object-fit: contain` on a
  plain surface, and hide the initials tile behind it. Remote artwork keeps
  each view's own fit. `refreshDetailArtwork()` now finds the detail picture by
  class, not by its whole class name.
- Station pictures: a fetch of a user's station picture can now be stopped.
  `stationImageUrl()` takes a `signal`; when every view that asked has stopped
  waiting (and the player bar, which asks without one, has not asked), the
  fetch itself stops with no further retry and is forgotten.
- Tuner dial, card height: the dial is sized from the height the other rows
  leave. With the default line height a station name in another script (seen
  with a Chinese name) is drawn with a fallback font that has a taller line, so
  its card grew from 39 to 41 px, every card stretched with it, and the dial
  lost 2 px while that station was in the strip. Cards now have a fixed height
  (39 px) and fixed line heights.
- Tuner dial, first play: before anything has played there is no player bar,
  so the dial was sized for a taller area and shrank when the bar appeared on
  the first play, and stayed small until restart. `#app:not(.has-player)
  .tuner-root` now keeps the player bar's height free as bottom padding. Side
  effect: in a window narrower than about 1000 px (where the stacked player bar
  is 198 px tall) the dial is smaller before the first play than it used to be.
  It is the same size before and after the first play.
- Tuner dial, messages: the strip under the dial lost its height when it showed
  a message ("Loading stations", "No stations found for this country.", the
  empty favorites message) instead of cards. It now has a minimum height equal
  to the card row (70 px; 66 px at 760 px wide and under), and the status line
  under it stays on one line.
- Sound meter: `src/lib/audio-engine.js` has a visual side tap, a second
  `AnalyserNode` fed from the same point as the EQ analyser and connected to
  nothing, so it never changes what is heard or what `verifySignal()`
  measures. It is made only for an element already attached to a running
  graph; it never creates or resumes the audio context. `src/lib/audio-signal.js`
  reads it once per frame for every subscriber and runs only while something
  plays, the sound is audible (not muted, volume above 0) and the window is
  visible; otherwise nothing is scheduled and the tap is disconnected.
  `src/lib/player-meter.js` draws 14 bars (about 40 Hz to 16 kHz, 3 dB per
  octave tilt, boost-only auto-gain up to 18 dB plus 6 dB per band) at 15
  frames a second, and redraws only when a lit segment changes. The canvas is
  90 x 36 px in whole device pixels, which gives 10 to 12 segments depending
  on the display scale (12 at 100%). There are two meter blocks in the player
  bar: one in the progress row of the wide bar, shown only while that row is
  at least 330 px wide so the seek slider keeps at least 120 px, and one at the
  end of the button row of the stacked bar (1000 px and under), which gives way
  before any button. CSS lays out at most one, and only a laid-out one listens.
  The meter also does not listen when reduced motion is requested.
- Sound meter setting: **Settings > Appearance > Sound meter in the player
  bar**, stored as `soundMeter` inside the existing settings value
  (`worldmedia.settings.v1`); only an explicit `false` turns it off.
- Knob text: the knob showed the station name followed by its source, for
  example "My Playlist". It now shows only the name (with a star for a
  favorite). The source stays on the card's second line and in its tooltip.
- Tuner card size: **Settings > Appearance > Tuner card size**, stored as
  `tunerCardSize` (`small`, `medium`, `large`; anything else is `small`) inside
  the same settings value. Small is the card as before. Medium (56 px) and
  Large (84 px) cards have bigger text and a picture box; the strip's minimum
  height grows by exactly the extra card height, so the dial keeps its size
  within a size. When the dial gets too small for the knob's three lines, the
  station name and then the count are hidden on Medium and Large.
- Tuner card pictures: `src/lib/tuner-card-art.js` gives each Medium or Large
  card a fixed box with the station's initials. Nothing loads until the strip
  has not been rebuilt or scrolled for 350 ms; then only cards in view start,
  each once, through `artwork.js` (the user's own station picture first, then
  the station's relay artwork). A card that leaves the strip stops its load
  (including a station picture still being fetched). Boxes move into the
  rebuilt card on each step, and the last 120 finished boxes are kept. A change
  of the station-images list while a card is loading is checked again for that
  card once its load settles.
- No new profile key: both settings are fields inside the existing settings
  value. Every release keeps settings fields it does not know, so going back
  to v0.1.9 keeps favorites and settings, and the two choices are still there
  on return.
- Tests: `tests_python/test_media.py` relay tests used a 1-second idle timeout,
  so on a busy machine the endless-stream test could see an empty body. The
  timeout in those tests is now 10 seconds, and a new test covers a 1.5-second
  pause before the relay's first read completes (`tests_python/fixture_server.py`
  gained a `?pause=` option). The relay code itself is unchanged.

## Evidence

- `npm test`: 711 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 467 passing
  tests, 4 skipped.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Final release files (installed WebView2, disposable state):
  - headless single EXE: `/`, `/api/health`, `/api/v1/session`, authenticated
    runtime status and the 0.1.10 notices; all 17 frontend files served
    byte-identical to `frontend/`; clean authenticated shutdown;
  - portable ZIP windowed launch gate: extracted into new folders, one with
    every file marked as downloaded (`ZoneId=3`); both opened a visible window
    (6.8 s and 6.2 s); all three `webview\lib\runtimes` folders are present;
  - single EXE marked as downloaded opened a visible window (7.7 s); About and
    Settings show v0.1.10; Settings > Appearance has "Tuner card size" and
    "Sound meter in the player bar";
  - ZIP integrity: 453 entries (396 files); bundled frontend and all 16
    `worldmedia_*.py` modules byte-identical to the repository; no profiles,
    state, logs, downloads, tools, tests or repository metadata.
- Screenshot sweep on the build before the version bump (the only differences
  are the version strings): Library (default, detail panel, Favorites, My
  Playlists), Tuner (before play, and playing at each card size), Grid,
  Discovery, About, Settings at Appearance, the equalizer panel and the song
  log at 1024x640, 1280x801 and 1921x1080 in the real window, plus the Light
  and Midnight themes and the meter switched off at 1280x801, were reviewed by
  eye. No control is off screen and nothing overlaps; the dial is round,
  centred and the same size before play, while playing and after Stop. Small
  cosmetic points found are listed under Boundaries.
- Sound meter cost, measured in the real window on the test machine: about 4
  to 8 percent of one CPU core while playing with the meter visible; zero at
  rest (paused, stopped, muted, volume 0, or switched off).

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,061,438 | `37F360F1FD4639DB8E47A363BE56BC8C2795D4DC289A9FDA6837A259CEBC5FB0` |
| `WorldMediaWindows-0.1.10-portable.zip` | 14,852,759 | `D4923978761466D388C0BACE2E05F36B1FF6B1AB31F8D29012A21E6A539CD0D9` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- The long message shown for an empty Favorites list (or category) on the
  Tuner can wrap to two lines in a narrow window, which makes the strip taller
  and the dial smaller while it is shown.
- The glow shown when the mouse is over the dial makes the dial's rim look
  slightly bigger. Nothing changes size.
- Before the first play, in a window narrower than about 1000 px, the dial is
  smaller than it was in v0.1.9 (it keeps room for the stacked player bar).
- At 1000 px wide and under, the mute button overlaps the seek row by 1 px.
  This is older and unchanged.
- The sound meter shows flat bars for playback that does not go through the
  local relay's audio engine: a stream that falls back to direct cross-origin
  playback when the relay cannot be used (the EQ is unavailable then too), or
  while Windows has suspended the audio context.
- The sound meter reads the sound after the EQ and its limiter, and lifts
  quiet sound; it is a sign of activity, not a level measurement.
- Cosmetic points seen in the screenshot sweep and left as they are: station
  initials of four letters (for example "SWR3") are cut by about 1.5 px at
  each side in a Medium card's picture box when the station has no picture; in
  the Light theme the seek and volume tracks are almost the colour of the
  player bar (older, unchanged); the small status line under the player bar
  cuts the bottom of letters such as "g" (older, unchanged); at 1024x640 a long
  station name on the knob ends in an ellipsis.
- Code review points that were not changed: "the meter moves other controls"
  (accepted as it is: only the seek slider gives way, in the wide bar, and only
  down to 120 px), and the wrapped empty-favorites message above.

The v0.1.9 boundaries still apply.
