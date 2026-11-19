# v0.1.11 release verification - 2026-11-18

Release scope: a new Visualizer tab (ported from Psychedelia Studio, the
author's own project), the bugs reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) on 17
November (playlist channels filed as TV, favorites missing from the dial, the
player bar jumping on a station change) and requests from
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
(station pictures for names a file cannot have, a list of rejected pictures,
Move to bottom, Remove all favorites). Work on the visualizer continues after
this release. See [release notes](RELEASE_NOTES_0.1.11.md).

## What changed and why

- Visualizer: a new tab between Discovery and About, `src/modes/visualizer.js`
  and `src/visualizer/`. It draws WebGL scenes that follow the sound, read from
  the same visual side tap the sound meter uses (`src/lib/audio-signal.js`); it
  never creates or resumes the audio context and never changes what is heard.
  Nothing of it is loaded until the tab is opened, and leaving the tab stops
  its loop and frees its WebGL context.
- Visualizer scenes: 71 scenes are offered (26 Light, 21 Medium, 24 Heavy),
  each loaded as its own chunk when first shown. The scene code is copied from
  Psychedelia Studio by `scripts/import_psychedelia.mjs` into
  `src/visualizer/vendor/psychedelia/`, with a manifest of every file, its
  upstream commit and hash, and the borrowed pieces. Eight more 3D flights are
  imported but held out of the list (`HELD_SCENES` in `src/visualizer/scenes.js`)
  because their camera still passes through a surface and the picture jumps to
  one flat colour; two looks are left out for the same reason.
- Visualizer safety: a notice about flashing lights is shown before the first
  picture. A flash limiter is always on (`src/visualizer/flash-limiter.js`): at
  most three large changes of light a second, scene and effect changes go
  through a fade that is charged to the same budget, and each scene has a cap
  on how fast its clock may run, set from a brightness-step check of every
  look with the sound surge held at its most.
- Visualizer effects and overlays: 38 post effects and 25 overlays (18 from
  Psychedelia, 7 written for this app), both off by default, at most three of
  each at once (two at Low). One overlay can be blended into the scene. Calm
  scenes get only the effects that do not enlarge steps of light.
- Visualizer load: Quality (Low, Medium, High), Frame rate (15, 30, 60) and
  Brightness. An automatic step-down (`src/visualizer/step-down.js`) measures
  only frame intervals; when a scene cannot keep up it draws fewer effects,
  then fewer overlays, then lowers quality, then frame rate. It belongs to the
  scene shown: the next scene starts at the chosen settings, the choice itself
  is never shortened, and a scene remembers what it needed for the visit.
- Visualizer favourites: the star keeps scene, look, effects and overlays.
  They are fields inside the existing settings value, separate from station
  favorites.
- About: a "Visualizer credits" section lists the borrowed shader code from the
  manifest, loaded only when About is shown. `CREDITS.md` and the packaged
  notices carry the same list.
- Playlist import: a channel whose file does not say radio or TV used to take
  the "Add as" choice, which started on TV, so a radio playlist imported into
  a fresh copy became TV (issue #6). "Add as" now starts on Auto, which decides
  from the file's own marks and audio file endings, and the result says what it
  chose. Importing the same playlist again with another type moves its
  favorites to the new type, keeping place, category and equalizer curve.
  Only M3U is stored, so older releases still read `playlists.json`.
- My Playlists: a first read of the playlists that failed is tried again when
  My Playlists opens. Own playlist channels no longer show "See provider
  terms".
- Tuner: the status line says when favorites are saved as the other type
  (TV or radio) and so are not on this dial.
- Player bar: while the next item connected, the Play button was hidden, which
  narrowed the controls and moved the whole bar sideways and back on every
  station change. It now stays in place, disabled.
- Station pictures: a station name with characters a file name cannot have
  matches a picture that uses `-`, `_`, a space or nothing in their place.
  Settings > Station images shows the rule and lists the pictures rejected at
  the last scan, with the reason.
- Favorites: "Move to bottom" on cards in My order, and "Remove all favorites"
  (asks first; also removes the favorites' own equalizer curves, and changes
  nothing if any part cannot be saved).
- Local port (Windows): the server takes its port exclusively. If the usual
  port is busy and answers as World Media, a new copy waits up to 8 seconds
  before it tries another port. `native.log` records the port and process id.
- Small visual fixes from the v0.1.10 record: four-letter initials on Medium
  and Large Tuner cards, the Light theme's slider tracks, the status line
  under the player bar, and the "0 dB" label in the EQ graph.
- No new profile key: the Visualizer's settings and favourites are fields
  inside the existing settings value (`worldmedia.settings.v1`). Every release
  keeps settings fields it does not know.

## Evidence

- `npm test`: 990 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 490 passing
  tests, 4 skipped.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Final release files (disposable state, own ports):
  - headless single EXE: `/`, `/api/health`, `/api/v1/session`, authenticated
    runtime status (403 without the token) and the 0.1.11 notices; all 97
    frontend files served byte-identical to `frontend/`; clean authenticated
    shutdown;
  - headless portable launcher from the extracted ZIP: the same checks pass;
  - ZIP integrity: 533 entries (476 files); bundled frontend and all 16
    `worldmedia_*.py` modules byte-identical to the repository; all three
    `webview\lib\runtimes` folders present; no profiles, state, logs,
    downloads, tools, tests or repository metadata;
  - portable ZIP windowed launch gate: extracted into new folders, one with
    every file marked as downloaded (`ZoneId=3`); both opened a visible window
    (6.2 s and 5.2 s);
  - single EXE marked as downloaded opened a visible window (7.5 s); the tab
    row has Visualizer between Discovery and About; About shows v0.1.11 and
    the "Visualizer credits" section; the Shutdown button closed it cleanly.
- Going back and returning: a data folder made by v0.1.11 (an imported
  playlist on Auto, favorites, a category, a moved card, theme, card size,
  song log, Visualizer settings and a starred favourite) was opened with the
  published v0.1.10 EXE, used lightly, and opened again with v0.1.11. Nothing
  was lost in either direction; `profile-preferences-extra.json` was
  byte-identical throughout.
- Screenshot sweep of the final build at 1024x640, 1280x800 and 1920x1080
  (113 pictures; Light and Midnight at 1280x800 for the screens that changed),
  reviewed by eye: no control off screen, nothing overlapping, About and
  Settings show v0.1.11. Small cosmetic points are listed under Boundaries.
- Visualizer in the real window (WebView2) on the test machine: Medium at 30
  frames a second holds about 30 with no step-down, at about 10 to 24 percent
  of one CPU core with no overlay; one overlay adds about 6 points; brightness
  steps between frames stayed at 0.02 or less; the step-down drops effects,
  then overlays, then quality, and the next scene starts at the chosen
  settings again; leaving the tab returns the app to its idle level with no
  canvas and no draws.
- Brightness-step check (the flash check in `tests/helpers/`): every offered
  scene and look, on the graphics card, with the surge held at its most, over
  the same stretch of scene clock (360 s at 1x). The speed caps and the calm
  list in `scenes.js` record the numbers.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,397,459 | `B08C1E3D9F9BAAF7FC9BAF89F27523426C174C33B644E6506D8113DD838C143E` |
| `WorldMediaWindows-0.1.11-portable.zip` | 15,195,324 | `E90F4F8D85A9812C70A79151ABEDE224D46585D56A52C86A78134C9B72CA27DC` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- The Visualizer is a first version. Eight 3D flights and two looks are held
  out until their camera paths are fixed upstream. Not ported yet: the Palette
  Map effect, the Strobe, Text, Lyrics and Image overlays, and the visualizer
  behind the Tuner. Overlay glow is off at every quality.
- The flash limiter bounds how often and how fast the light changes; it cannot
  rule out every risk for a person sensitive to flashing lights or patterns.
- A new 3D scene takes about 1 to 3 seconds to appear the first time (its
  shader is compiled); the old picture keeps moving meanwhile. One frame gap
  of about 0.1 to 0.3 s can follow when the driver builds the shader.
- A scene that needed a lower quality earlier in the visit starts lowered when
  shown again, without a note. Choosing a quality or frame rate clears that.
- Fractal Canyon runs at about 28 frames a second at High on the test
  machine's graphics card and stays at High; at 60 frames a second it steps
  down.
- Trails from the feedback effects are dimmer at 15 frames a second than at
  60.
- Not built from discussion #8: renaming a station, dragging cards to reorder,
  starring single songs, `.json` and `.csv` import, and switching to the
  best-quality stream by itself.
- With a catalog view open, the Library still loads further catalog pages in
  the background for the first minutes (older, unchanged).
- Cosmetic points seen in the screenshot sweep and left as they are: the
  "Clear cache" label in Settings wraps onto two lines (older); at 1024x640 a
  long station name on the knob ends in an ellipsis; very long favorite titles
  and one sidebar source name end in an ellipsis; the "Psychedelia Studio"
  link in the About credits uses the browser's link colour.
- Code review points that were not changed: a star on a calm scene does not
  save effects that scene never draws (a favourite belongs to its scene);
  opening About evaluates the scene-name table once.

The v0.1.10 boundaries still apply, except the four cosmetic points fixed
above.
