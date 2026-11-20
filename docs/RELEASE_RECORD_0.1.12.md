# v0.1.12 release verification - 2026-11-20

Release scope: the requests promised in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
(starred songs, renaming a station, dragging cards to reorder, `.json` and
`.csv` import, switching to the best stream), a setting for how much of the
processor the app may use, more Visualizer scenes, looks, effects and
overlays, a Visualizer panel with folding sections, two fixes for
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) (the source
label on wide Favorites cards, and a live station that went silent when its
connection closed, found while looking into a report there), and Library,
player and Settings fixes. See [release notes](RELEASE_NOTES_0.1.12.md).

## What changed and why

- Starred songs: `src/lib/starred-songs.js`, the Song log panel
  (`src/lib/song-log-panel.js`) and the player bar's star
  (`src/lib/song-star.js`). Stored by the local server in the data folder
  (`state/starred-songs.json`, `worldmedia_starred.py`), never in the browser
  profile, so older releases are not affected. Each save carries a revision;
  the server keeps only newer writes, so two windows do not undo each other's
  changes. Copied into backups.
- Rename: `src/lib/favorite-names.js` and `src/lib/favorite-rename.js`, the
  form in the favorite's details (`src/modes/library/detail.js`). Names are
  kept apart from the favorites, under their own key that travels with the
  profile and into backups; the favorite itself keeps its original name, so
  an older release shows the original names. v0.1.11 does not know that key:
  while it is in use it leaves the names out of
  `profile-preferences-extra.json`, and v0.1.12 writes them back from the
  app's browser profile at its next start. At most 5,000
  favorites can have a name of their own, of up to 80 characters. Directory
  lookups and stream checks always use the station's own name
  (`underOwnName` in `src/lib/other-streams.js`).
- Drag to reorder: `src/modes/library/render.js` and `moveFavoriteTo` in
  `src/lib/state.js` (one save per move), only in Favorites with **My
  order**; a drag of anything else (such as a playlist file) is not taken for
  a reorder.
- JSON and CSV import: `worldmedia_playlist_tables.py` turns a JSON or CSV list
  into the same M3U form every other playlist is stored in, so
  `playlists.json` keeps its format and older releases still read it. A
  file's size (8 MiB) and number of entries (50,000) are limited.
- Pick the best stream: `src/lib/best-stream.js` ranks the listed streams by
  what the directory reports; `src/lib/media-failover.js` gives the best one
  a head start of 6 seconds; `src/lib/start-failover.js` hands a stream that
  connected but never began over to the streams not tried yet (30 seconds at
  the latest; a stream that has begun gets 10 seconds, `START_CONFIRM_MS`,
  from its start to play a full second). Auto (verified):
  `src/lib/best-stream-auto.js` and `src/lib/stream-verify.js` (the checks),
  with the two streams read by the local server
  (`worldmedia_stream_probe.py`), at most two checks per station a week, one
  at a time; nothing is looked up before a start, the first check waits for
  45 seconds of playing from the first sound, and a check stops when the
  station is paused or changed or the setting leaves Auto
  (`followBestStreamSetting`). Station names match when they are equal or
  share the same name before a description, as in "Name: description [Tag]"
  and "Name [Tag]" (`sameStationName`). A directory that does not answer in
  time is tried again after 30 minutes. The details line
  (`src/modes/library/other-streams.js`) says "It is used from the next
  start." under a verified stream and offers "Use the station's own stream"
  at once. The old setting (`bestStream: false`) reads as Off.
- Processor use: `src/lib/processor-budget.js` is the one place that holds the
  level and the limit (2% to 80%, in steps of 1; a typed value outside is
  corrected, with a note). At Balanced and High the Visualizer reads the
  app's processor use every 3 seconds while it plays
  (`worldmedia_processor.py`: the app's and the window's processes, as a
  share of the whole processor) and steers its own quality by it, with a wait
  after each change so it does not swing back and forth. At Low nothing is
  read and nothing changes from v0.1.11.
- Processor use, what Balanced and High add (`processorExtras`): a fourth
  quality, Very high, with a budget of 4.8 million pixels (High's is 2.4
  million). It draws more than High where the tab has more device pixels
  than High's budget, and the same picture elsewhere. Light and Medium scenes
  draw at it, and of the heavy scenes only
  those measured holding 30 frames a second there (`VERY_HIGH_HEAVY_ALLOWED`:
  Mandelbox Flight, Curl-Noise Silk, Fluid Ink, Lenia, Physarum); the others
  draw at High, and the panel says so. At the High level, Curl-Noise Silk,
  Fluid Ink and Physarum start one size larger at High or Very high quality
  (`SIM_SIZES_ABOVE_HIGH`); Lenia keeps its size, as its larger world started
  darker. No level changes the frame rate choices, the labs' worker share,
  the scenes' speed caps or the most effects and overlays at once (three of
  each).
- Visualizer scenes: 28 more (99 offered: 32 Light, 23 Medium, 44 Heavy),
  with the flash check over every offered look (results under Evidence).
  Line drawings are drawn through `src/visualizer/line-host.js`, simulations
  through `src/visualizer/sim-host.js` (with
  `src/visualizer/shadertoy-adapter.js` for the frame-feedback scenes), with
  per-quality limits on what they build each frame; the five own scenes are
  in `src/visualizer/own/`. Five of the eight 3D flights held out in v0.1.11
  are now offered; three stay held (`HELD_SCENES`) because their brightness
  still steps too far from one frame to the next. Everything a scene makes is
  freed when the scene changes, the tab closes or the graphics context is
  lost.
- Buddhabrot Lab: `src/visualizer/accumulating-scenes.js`, built point by
  point in a worker (`src/visualizer/density-host.js`,
  `src/visualizer/density-worker.js`) at a share of one core set per quality
  (0.15, 0.25, 0.35); the worker ends when the picture is finished. Its
  motion and color cycling are held still, so a finished picture costs
  nothing more. The cross-fade into it stretches up to 4 seconds
  (`CROSSFADE_STRETCH_MS` in `src/visualizer/transition.js`) until its shown
  picture is bright enough, so the change does not pass through black.
- Extra looks: `EXTRA_LOOKS` in `src/visualizer/looks.js`; seven more
  formulas of 2D Formula Lab were measured and left out because they change
  too much of the picture's brightness from one frame to the next.
- Visualizer effects and overlays: Palette Map
  (`src/visualizer/fx-catalog.js`; its color bands pinned off and its offset
  never moved by the beat) and Strobe (`src/visualizer/overlay-patterns.js`,
  World Media's own, in place of Psychedelia's full-screen strobe), with the
  flash check (results under Evidence). Strobe's Style is saved as
  `visualizerOverlayStyles`, inside the settings value.
- Slow drift: `src/visualizer/drift.js`, `src/visualizer/swell.js` and
  `src/visualizer/overlay-motion.js`. Scenes whose drift raised their
  brightness steps keep no drift or drift less (`SCENE_DRIFT` in
  `src/visualizer/scenes.js` has the numbers).
- Visualizer panel: `section()` and `summarize()` in
  `src/visualizer/index.js` give each section a title button with its state
  at the right; folded sections are saved as `visualizerFolded`
  (`src/lib/visualizer-settings.js`), inside the settings value. The
  Overlays switch is always visible: before, with the switch off, the
  section was a small folded line that was easy to miss.
- Mood: `src/visualizer/mood.js` (hits merged across bands, hi-hats weighted,
  tempo from 80 beats a minute). The music turns energetic above 0.48 and
  leaves it below 0.42 (was 0.65 and 0.57), set from two-minute readings of
  seven stations (results under Evidence). It starts fresh on another station
  or after a gap in the sound, and keeps its last word until the new reading
  is ready.
- Spelling: `src/visualizer/spelling.js` shows names that come from the
  scenes and effects in American spelling; saved values are unchanged.
- Live reconnect (`src/lib/player.js`): a plain live stream reports an
  unbounded length while it plays, then, about two seconds before it ends,
  the time played as its length; the end was then taken for the end of a
  file, so nothing reconnected (also in v0.1.11). The start now stays known
  as unbounded (`playSession.unbounded`), and its end is a dropped connection.
  A file with a length is not restarted.
- Favorites cards (`src/styles/library.css`): with technical source details
  on, the source badge sat in a grid column that shrank to nothing in a wide
  window. The compact card now gives the badge the room there is, on one
  line, and cards with Move buttons start at 318 pixels wide.
- Fixes: the catalog retry (`src/modes/library/progress.js`,
  `src/lib/catalog-scheduler.js`: an error without a Retry-After waits 1.5 s,
  doubling up to 30 s, and `null` is no longer read as 0 ms; two failures in
  a row hold the source until **Retry now**); PeerTube's search depth
  (`src/adapters/peertube.js`); live lists only while shown and their retry
  wait (`src/modes/library/snapshots.js`, `src/modes/library/chain.js`, and
  each adapter's `snapshotRetryMinMs`); Play after an ended stream
  (`src/lib/player.js`); the switch and button width in Settings rows
  (`src/styles/base.css`); the quiet second try of an automatic profile save
  (`src/lib/profile-transfer.js`); a Visualizer start that fails frees what
  it had made.
- Unused functions, imports and style rules were removed; the app behaves the
  same.
- No new key in the old profile file: the new settings are fields inside the
  existing settings value (`worldmedia.settings.v1`); the favorite names and
  own-stream choices have keys of their own that travel with the profile;
  starred songs are a file of the local server.

## Evidence

- `npm test`: 1,432 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 559 passing
  tests, 5 skipped.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Final release files, on the test machine:
  - The one-file EXE, started without a window, answered its health check in
    4.5 s, served the page and all 131 frontend files byte for byte, answered
    403 without the session token, and exited with code 0 after shutdown.
  - The portable ZIP has 571 entries (514 files) under one top folder, no
    unsafe names, the three WebView2 loaders, and a frontend and server
    modules identical to the repository (131 of 131 and 20 of 20). An
    extracted copy passed the same checks.
  - Windowed launch with every file marked as downloaded from the internet:
    the portable folder showed its window in 4.8 s and served the page in
    5.8 s; the one-file EXE in 6.1 s and 7.1 s. Both closed with exit code 0
    and no failure lines in the log.
  - In the real window, About and Settings read v0.1.12, the Tuner loaded 80
    stations and played one, **Radio** pressed again reloaded the list, every
    tab opened, and there were no page errors.
- Going back and returning: a data folder made by v0.1.12 with a starred
  song, a renamed favorite, a changed order, a JSON and a CSV playlist, Pick
  the best stream on Auto (verified), Processor use at Balanced and a folded
  Visualizer section was opened with v0.1.11 and again with v0.1.12. v0.1.11
  started, showed the favorites in the changed order under their original
  names and both playlists, and played a station. Back in v0.1.12 the name,
  the order, the starred song, both playlists and the settings were all
  there. `starred-songs.json` had the same SHA-256 before, between and after.
  v0.1.11 removed `profile-preferences-extra.json`, which then held only keys
  it does not know; v0.1.12 wrote it again at its next start with the same
  SHA-256.
- Screenshot sweep at 1024x640, 1280x800 and 1920x1080 in dark, and at
  1280x800 in light: 68 pictures of 16 screens, each looked at. The version
  reads 0.1.12 on About and in Settings, nothing overlaps and nothing is off
  screen. The cosmetic points found are listed under Boundaries.
- Visualizer in the real window (WebView2) on the test machine:
  - Very high, at Balanced: Plasma and Kaleidoscope drew 4.8 million pixels
    against 2.4 million at High, at 29 to 30 frames a second and 1.4 to 2.1
    percent of the whole processor; the largest brightness step at the
    switch was 0.02. Mandelbox Flight held 30.0 frames a second at Very high.
    Fractal Canyon showed "This scene draws at High" and drew at High's size.
    Back at Low, Very high left the list, the picture drew at High and the
    saved choice was kept.
  - The larger simulations at the High level: Curl-Noise Silk with about a
    million particles (a quarter of that at Low), Fluid Ink and Physarum on
    grids 1.5 times as wide and as high; Lenia unchanged. All drew about 30
    frames a second at 1.5 to 2.3 percent of the whole processor. Physarum
    went from High to Low with no restart and no dip.
  - Buddhabrot Lab, five visits from bright and dark scenes: the old picture
    was gone after 1.5 to 2.4 s, the picture never came near black, and the
    largest brightness step was 0.07. It built its picture for 47 to 58 s and
    then held it. One worker ran while it built, and none after it finished,
    after a scene change or after leaving the tab; 4.1 percent of the whole
    processor while building, 1.3 percent after. None of its six looks came
    near black.
  - Band Ridgelines and Sound Ring: 29.2 to 30.0 frames a second at 30.
  - With the tab left: no Visualizer canvas and no worker.
- Processor use in the real window on the test machine: at Balanced and High
  the app read its processor use 14 to 20 times a minute while the
  Visualizer played, and from 3 s after a switch to Low it read nothing. The
  reads stopped within 0.5 s of minimizing the window. A limit typed as 1
  became 2, with "The limit is from 2% to 80%." for about 5 s and no layout
  jump; 81 became 80.
- Mood in the real window, two minutes per station, at the old line of 0.65:
  an ambient station calm all the time; a pop station steady 83 percent,
  energetic 8 percent; a rock station steady 97.5 percent; a downtempo house
  station steady 83 percent; a trance station energetic 24 percent; a drum
  and bass station steady 82.5 percent; a metal station steady 82 percent.
  With the line at 0.48: the trance station energetic 87.5 percent of the
  time; the rock and the ambient station calm or steady and never energetic.
- Strobe's Style: Sweep was kept across a change of tab and across a restart
  of the app.
- Visualizer panel at 1024x640, 1280x800 and 1920x1080: nothing cut off or
  overlapping; the sections fold with the keyboard; folded sections were
  kept across a restart.
- Favorites cards with technical source details on (issue #6): v0.1.11 showed
  the squeezed, wrapped badge (about 26 pixels wide). This release showed
  every badge whole on one line at 1024x640, 1280x800, 1920x1080 and in a
  maximized window, in Favorites with My order and A-Z, and in My Playlists.
- Live reconnect: a live stream closed three times by the test. Each time
  "Connection lost. Retrying..." showed at the end, the station was connected
  again 2.0 s later and the sound came back about 4 s after the end, on the
  same station. Pause, Stop, or another station picked during the retry did
  not bring the old station back.
- Move buttons on Favorites cards: drawn 24 x 24 pixels, each answering the
  pointer over about 25.5 pixels, with no overlap.
- Pick the best stream, Auto (verified), against live stations: a station
  playing at 128 kbps MP3 was verified 290 s after it started; the details
  line read "Better stream: 256 kbps MP3, verified. It is used from the next
  start." with "Use the station's own stream" shown at once. Its 64 kbps AAC
  entry, which announces its name with more words, passed the name check
  (one match so far). Two stations that send no song titles were not
  switched and kept their own stream.
- Brightness-step check (the flash check in `tests/helpers/`): every offered
  scene and look, on the graphics card, with the surge held at its most, over
  the same stretch of scene clock (360 s at 1x), stays under a step of 0.10
  of full brightness from one frame to the next. The five 3D flights offered
  now step by 0.084 at most (Apollonian Foam Flight); the 28 extra looks by
  0.05 at most. Strobe at its strongest, in every style and blend, adds at
  most 0.013 to the scene's own step and stays within the limiter's three
  large changes a second. The speed caps, the calm list and the looks left
  out in `scenes.js` and `looks.js` record the numbers.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,615,219 | `53B121D3D013BCB85140E8B4B307BB06B3CF995F9D85F8526B6835D3A1548220` |
| `WorldMediaWindows-0.1.12-portable.zip` | 15,395,310 | `F0B90F004B228D87FE52D68B3EA0472AD9753E6F2A1F5B58727F5D2674068CAD` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- Processor use steers by a limit; it is not a hard cap. At Balanced and High
  the computer may run warmer and louder, a laptop's battery may last less,
  and an overloaded computer can stutter the sound.
- Very high is sharper than High only where the window has more pixels than
  High can draw. Heavy scenes other than Mandelbox Flight, Curl-Noise Silk, Fluid Ink,
  Lenia and Physarum draw at High when Very high is chosen.
- Buddhabrot Lab takes about a minute to build its picture.
- Auto (verified) only switches a radio station that announces song titles,
  only after two matching songs a few minutes apart, and only from the next
  start of that station.
- At most three effects and three overlays at once, at every Processor use
  level.
- The mood follows the drums and the tempo, and it changes a lot with what is
  playing; fast music such as drum and bass or metal often reads as steady.
- With Effects on, the list of effects is long: fold Effects to bring the
  Overlays section into view.
- The flash limiter bounds how often and how fast the light changes; it cannot
  rule out every risk for a person sensitive to flashing lights or patterns.
- Favorites cards are laid out in columns of equal width, so a long station
  name ends in an ellipsis even when there is free room beside the cards.
- With technical source details on, long source names in the Library sidebar
  end in an ellipsis.
- Two links, **Psychedelia Studio** on About and **What this means** in
  Settings, have the browser's default link color.
- An empty Tuner dial does not load again by itself after a source failed to
  answer; pressing **Radio** or **TV** loads it again.

The v0.1.11 boundaries still apply, except these, done in this release: five
of the eight held 3D flights are offered; the Palette Map effect and a Strobe
overlay; renaming a station, dragging cards to reorder, starring single
songs, `.json` and `.csv` import and switching to a better stream; the "Clear
cache" label wrapping in Settings; and a long station name on the knob, which
now shows in full on hover.
