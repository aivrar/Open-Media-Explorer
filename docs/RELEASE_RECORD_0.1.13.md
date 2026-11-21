# v0.1.13 release verification - 2026-11-21

Release scope: the requests from
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8)
taken up in this release (a Now Playing tab, a mark on stations that did not
play, a station picture by file choice or drop, a larger song title, no seek
bar on live radio and TV), the three drag-to-reorder faults reported in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) (drops that
worked about half the time, a "no entry" cursor over the buttons, a card
landing one place too low), the Visualizer behind the Tuner, three overlays,
two blends, Extra glow, four more scenes (103 in all), a mood line read from
the spectrum, and player, Tuner, Grid and profile fixes. See
[release notes](RELEASE_NOTES_0.1.13.md).

## What changed and why

- Now Playing tab: `src/modes/now-playing.js` and
  `src/styles/now-playing.css`, between Discovery and Visualizer. It only
  reads what the player, the favorites, the station pictures and the shared
  sound signal already keep, sends no requests of its own beyond the artwork
  the player bar asks for, and leaving the tab removes every listener, timer
  and picture load. The time played (`src/lib/play-clock.js`) counts only
  while the media really advances, from the element's `playing` event until
  it waits for data, pauses, ends, fails or stops, on a monotonic clock, so a
  pause, buffering or a reconnect adds nothing. The large meter is the player
  bar's meter (`createPlayerMeter` in `src/lib/player-meter.js`) with about
  20 segments over its height (`NOW_PLAYING_METER_SEGMENTS`).
- Did not play last time: `src/lib/did-not-play.js` holds the rule,
  `src/lib/did-not-play-view.js` where it shows: only the user's own
  stations (favorites and My Playlists), on their Library and Tuner cards and
  in the details panel. A start the user asked for did not play when every
  stream it tried failed, or none began within the start limit (30 seconds,
  `START_FAILOVER_MS`) once no other stream was left to try. A second of
  playing clears the mark; Stop, a pause, another station or a start the
  browser blocked is no result. A station is not marked when the connection
  is at fault, because a connection that is down makes every station look
  dead: nothing is marked while the browser is offline, a name lookup that
  could not be done is the connection's fault, and a station that could not
  be reached at all is marked only when something outside answered in the
  last minute (`ANSWER_FRESH_MS`) or a small check says the connection works
  (`src/lib/connection-evidence.js`: Radio Browser's stats page, about 150
  bytes, through the local proxy, at most once every 30 seconds,
  `CONFIRM_EVERY_MS`). The marks are a cache in the page's storage
  (`worldmedia.didnotplay.v1`, at most 2,000 stations), not in the profile
  files or backups; Clear cache removes them. Marking never delays a play.
- Station pictures by file or drop: "Choose picture..." and "Remove picture"
  in the details form (`src/modes/library/detail.js`) and a drop on a card
  (`src/modes/library/picture-drop.js`), both through
  `src/lib/station-image-files.js`, for favorites and My Playlists stations
  only. The local server writes the file (`StationImages.save` and `remove`
  in `worldmedia_station_images.py`, routes `/api/v1/station-images/save`
  and `/api/v1/station-images/remove`): the bytes pass the same
  `validated_picture()` check as the station-images folder scan (the type
  from the content, at most 2 MB, SVG refused); the file name is made from
  the station's own name (`picture_stem`; for a renamed favorite, the name it
  came with), never taken from the request; the file is written whole (a
  temporary file renamed into place). The app asks before it replaces or
  removes a picture and names every file (at most 20); a yes covers exactly
  those files, and if the folder changed in the meantime nothing is changed.
  A save refuses to touch a file the folder lists only under another name,
  such as another picture's Windows short name (`RADIOP~1.PNG`): Windows
  opens a file by its short name too, so a station named like one could
  otherwise replace another station's picture.
- Drag to reorder (issue #6): `src/modes/library/render.js`. A card dropped
  anywhere on another card takes that card's place (`favoriteDropPlace`:
  coming from later in the order it goes before it, from earlier after it).
  Before, the place came from which half of the card the pointer was over,
  so a drop on the lower half of the next card put it one place too low.
  While a favorite is dragged, `dragenter` and `dragover` are both accepted
  over the whole results area. Before, only `dragover` over a card was, so
  the browser showed the "no entry" cursor for a moment on each element
  entered (the picture, the tag and move buttons) and over the gaps, and a
  drop let go at such a moment was refused. A drop in a gap or on the card
  itself changes nothing; a dragged file is never taken for a reorder.
- Live media in the player bar: `mediaTimeline` in `src/lib/player.js`
  decides, in this order. An item listed as on demand is never live. An item
  listed as live (a radio or TV station, a live delivery) is live from the
  press of Play, unless hls.js reports a complete list, dash.js a static one,
  or, played directly, the stream reports a finite length that is not
  growing (`LIVE_GROWTH`: grown on three updates over at least 10 seconds at
  about the clock's pace). Any other item follows hls.js or dash.js, else an
  endless or growing length. Live media shows no seek bar and no length, and
  the time shows how long it has played (the play clock), because a live
  stream's own position means nothing to the listener (one live TV channel
  read "498673:51:06"). On windows wider than 1000 pixels the name column
  takes the seek bar's room (`#player-seek.is-live` in
  `src/styles/base.css`). An item listed as on demand keeps its seek bar
  from the press of Play, disabled until its length is known. The record
  status follows the same decision, so a file in a playlist reads "This
  stream can be recorded."
- Song title: `.player-source.is-song` in `src/styles/base.css`, weight 600
  in the full text color, `clamp(14px, 0.45vw + 9.5px, 22px)` (about 14 px
  at 1024 pixels wide, 18 px at 1920, 22 px from about 2800); the station
  name `clamp(14px, 0.25vw + 11px, 18px)`. On wide windows the name column
  is at least `75vw - 760px` wide (680 px at 1920), at most 1400 px. The
  Tuner dial's station name grows the same way, from 13 to 17 px
  (`src/styles/tuner.css`).
- Starting a stream: Play registers its stream on a connection of its own
  (`registerMedia`, `ownConnection: true` in `src/lib/capture-client.js`),
  and a podcast episode's feed lookup for Play is sent at once, not queued
  behind browse lookups (`forPlayback` in `src/adapters/gpodder.js` and
  `src/lib/catalog-client.js`). The local server tells a host name that does
  not exist (`MEDIA_HOST_NOT_FOUND`) from a lookup that could not be done
  (`MEDIA_DNS_FAILED`) (`worldmedia_media.py`), and the player bar says
  which (`hostLookupFailureMessage` in `src/lib/media-failover.js`). After a
  failed start, Play stays in the bar and tries again, and Record is grayed
  with "Recording is available once this item plays."
  (`src/lib/capture-view.js`). A station's logo is shown whole in the player
  bar's square (`#player-art.is-logo`) and in the details panel
  (`.detail-thumb.logo-art`), on a plain surface, so the initials do not
  show through a transparent logo.
- Profile saves: each save goes on a connection of its own (`ownConnection:
  true` in `src/lib/profile-transfer.js`; `controlRequest` sends it without
  credentials, which the browser keeps apart from the page's other
  requests). Why: the browser opens at most six connections to the local
  server and queues the rest; on a first catalog load all six could be held
  for many seconds, so a save, which gives up after 10 seconds
  (`PROFILE_REQUEST_TIMEOUT_MS`), could run out of time in that queue
  without reaching the app, and "The portable profile backup could not be
  updated" showed. The slow catalog lookups (a podcast feed, a PeerTube
  video, an Owncast snapshot) now hold at most three connections at once
  (`SLOW_CATALOG_SLOTS` in `src/lib/catalog-client.js`).
- Tuner and Grid: `src/lib/live-load.js` with `src/modes/tuner.js` and
  `src/modes/grid.js`. The same view asked again keeps its list, and each
  source's stations are replaced when it answers, so a source that fails
  keeps its earlier stations and the status line says it could not be
  refreshed (`refreshKeepsList`, `failedSourceState`). A view left empty by a
  failed source tries again by itself after 8 and then 20 seconds
  (`LIVE_RETRY_DELAYS_MS`), only while the view is open; a try that falls due
  while the window is hidden waits until it is shown. The status line says
  "Loading 1 live source..." for one source and never "from 0 sources"
  (`liveStatusText`).
- Library: Retry asks refused podcast feeds again at once (`force` in
  `src/adapters/gpodder.js`); a feed the app refuses for its size or
  complexity (`FEED_REFUSED_AS_SENT`) is otherwise asked for again after six
  hours, as asking sooner gets the same answer. A picture address the app
  refuses is asked for once (`assetRefusedThisSession` in
  `src/lib/catalog-client.js`, used by `src/lib/artwork.js`): for the
  session, or for 10 minutes where the refusal comes from a name lookup that
  can be wrong for a while (`REFUSED_ASSET_TTL_MS`).
- Favorites and My Playlists cards show a long name on two lines, then an
  ellipsis, with the whole name on hover (`line-clamp: 2` in
  `src/styles/library.css`); with technical source details on, the Library
  sidebar shows long source names in full. An empty star on these cards
  takes the text color, as a white one did not show on a light theme's card
  (`.card-star:not(.is-fav)`). The links on About and **What
  this means** in Settings use the app's link color (`src/styles/about.css`,
  `src/styles/base.css`).
- Start-up tidy: `src/lib/startup-tidy.js`, run once per start by
  `initState` (`src/lib/state.js`) after the profile is restored and before
  the first save. It drops the names and category assignments of stations
  that are no longer favorites (the categories themselves stay), so a station
  made a favorite again shows its own name, not one left from long ago. It
  does nothing when the favorites could not be read or the restore failed,
  since every name would then look like a leftover.
- Local port change: the favorite names and own-stream choices are also kept
  in a file of their own, `state/profile-preferences-extra-copy.json`
  (`PROFILE_TRANSFER_COPY_KEYS` in `worldmedia_runtime.py`), because v0.1.9
  to v0.1.11 rewrite `profile-preferences-extra.json` with only the keys they
  know. The copy is read back only for keys the extra file lacks, and a name
  only for a favorite the main file still holds. Copied into backups.
- Sleep timer (`src/lib/sleep-timer.js`): the menu shows the running choice,
  a custom time too, and returns to Off when no timer runs. A custom time is
  kept to a tenth of a minute, up to 720 minutes, so the menu's label is the
  time that runs (`customSleepMinutes`); an empty or non-numeric answer starts
  nothing and leaves a running timer as it is.
- Visualizer behind the Tuner: `src/lib/tuner-background.js` (the rules) and
  `src/modes/tuner-background.js`, a setting off by default. It is drawn
  through the Visualizer's own mount, so the flash limiter and the processor
  budget apply, only after the photosensitivity notice was accepted in the
  Visualizer tab, only while sound plays and the Tuner is shown, and it stops
  3 seconds after the sound stops (`TUNER_BACKGROUND_STOP_GRACE_MS`). It
  draws Light scenes only (a chosen Medium or Heavy scene is drawn there as
  Plasma, and the choice is kept), no overlays and no effects, at Low quality
  and at most 30 frames a second, shown at 0.08 opacity
  (`TUNER_BACKGROUND_OPACITY`), which keeps every Tuner text at 4.5:1
  contrast or more. With the setting off, nothing of the Visualizer is
  loaded; leaving the Tuner unmounts it at once.
- Visualizer overlays: Ripples, Fireflies and Orbits, World Media's own
  (`src/visualizer/overlay-patterns.js`, rows in
  `src/visualizer/overlay-catalog.js`), calm and steady, with the soft blends
  only; Fireflies and Orbits count as medium cost, as they measured over 1 ms
  a frame. Two more blends, Lighten and Color (`OVERLAY_EXTRA_BLENDS`, drawn
  on the graphics card in `src/visualizer/fx-chain.js`, saved as `l` and `c`
  by `src/lib/visualizer-settings.js`); a line by the Blend choice says when
  choosing a blend set another overlay back to plain, as only one overlay is
  blended in at a time. "Extra glow" (`OVERLAY_EXTRA_GLOW`, Medium and High
  only) moves light rather than adding it: the sheet is faded by the glow's
  share before the glow is laid on. With Slow drift on, overlay sizes and
  spreads drift too (`src/visualizer/overlay-drift.js`, 0.06 of a setting's
  range), never a speed, count, color or strength. Overlay lines and dots are
  sized by the picture's height (`overlaySizeUnit`: one unit is a 720th of
  it, never less than one of its pixels), so they look the same at Medium
  and High.
- Under the effects: Fireworks, Lasers, Stage Lights, Lightning and Spectrum
  are drawn over the effects only (`under: false` in
  `src/visualizer/overlay-catalog.js`), as Cinematic already was. Under
  Mirror in its Kaleidoscope mode their light is copied around the picture and
  stepped the brightness past the limit (results under Evidence). A saved
  favorite with one of them under the effects draws it over them. The grayed
  box says "Not available for this overlay."
- Voronoi Cells takes no Mirror (`FX_LEFT_OUT` in
  `src/visualizer/scenes.js`): Mirror in its Kaleidoscope mode alone stepped
  its brightness by 0.102 a frame, over the limit with nothing else drawn.
  The panel grays Mirror there with the existing note, and the effects
  shuffle never picks it.
- Visualizer scenes: four more (103 offered: 32 Light, 23 Medium, 48 Heavy).
  DIFS Tunnel Flight starts on the values of its Koch Vault Orbit preset,
  the one preset it offers, and Quaternion Julia Flight on Amber Glass, the
  only look it offers, each with a speed cap of 1x (`SPEED_CAPS`);
  Quaternion Julia Flight takes only calm effects (`FX_CALM_SCENES`). Fourier Epicycles and 4D Polytopes start on
  new values (`LINE_SCENES_HELD` in `src/visualizer/line-scenes.js` is
  empty). Mandelbrot's Neon and Ocean looks are back with their colors
  cycling at half speed (`LOOK_ADJUSTED` in `src/visualizer/looks.js`).
  Three density labs stay held because they start too dark (FLAM3 Density
  Lab, IFS / L-System Lab and Attractor Density Lab; only Buddhabrot Lab is
  in `ACCUMULATING_RELEASED_IDS`), and Hypercomplex Slice Flight
  (`HELD_SCENES`) because its brightness still steps too far from one frame
  to the next. The effect "Heat Haze & Caustic Light" is named "Heat Haze"
  (`FX_LABELS` in `src/visualizer/fx-catalog.js`), as only its heat haze is
  drawn.
- Mood: `src/visualizer/mood.js` reads the music from the sound's spectrum,
  in eight bands from 40 Hz to 12.8 kHz: how much keeps starting anew, how
  many strong hits there are in the top bands, how regular they are, and how
  bright and how even the top of the spectrum is, all against the spectrum's
  own level, so the volume does not change the reading. The drum hits it
  counted before are no longer read: they came two to three times a second on
  almost any music. Calm below 0.20 (left above 0.27), energetic above 0.65
  (left below 0.57); a new word must hold 3 seconds and changes at most once
  in 10; the first reading after a start decides at once, and 5 seconds of
  quiet turn it calm. Nothing is allocated per frame.
- Visualizer panel: nearly opaque (`src/visualizer/visualizer.css`), so a
  bright scene behind it does not show through behind its text; "New effects
  now" and "New overlays now" use the panel's text size.
- Visualizer favorites and the overlay set: release 0.1.12 drops a whole
  favorite that holds a Lighten or Color blend, and takes an overlay it does
  not have out of a favorite when its tab opens. So `visualizerFavourites`
  and `visualizerOverlaySet` keep only what 0.1.12 reads as it is, and the
  whole lists are kept beside them in fields of their own,
  `visualizerFavouritesAll` and `visualizerOverlaySetAll`
  (`src/lib/visualizer-settings.js`), which 0.1.12 leaves untouched.
- No new key in the old profile file: the new settings are fields inside the
  existing settings value (`worldmedia.settings.v1`); the second copy of the
  names and own-stream choices is a file of its own; the station pictures
  are files in the `station-images` folder; the "Did not play last time"
  marks stay in the page's cache.

## Evidence

- `npm test`: 1,666 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 619 tests,
  612 passing and 7 skipped.
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Final release files, on the test machine:
  - The one-file EXE, started without a window, answered its health check in
    3.7 s, served the page and all 131 frontend files byte for byte, answered
    403 without the session token, and exited with code 0 after shutdown.
  - The portable ZIP has 571 entries (514 files) under one top folder, no
    unsafe names, the three WebView2 loaders, and a frontend and server
    modules identical to the repository (131 of 131 and 20 of 20). An
    extracted copy passed the same checks.
  - Windowed launch with every file marked as downloaded from the internet:
    the portable folder showed its window in 4.0 s and served the page in
    4.6 s; the one-file EXE in 4.9 s and 5.8 s. Both closed with exit code 0
    and no failure lines in the log.
  - In the real window, About and Settings read v0.1.13, every tab opened,
    and there were no page errors. The Tuner loaded 80 stations from 3
    sources and played one. With the volume at three quarters, the sound
    meter moved on an Internet Archive recording in all 20 readings taken
    over 20 s.
  - The Visualizer behind the Tuner showed 0.17 s after a station was
    chosen, at 0.08 opacity, went 0.02 s after leaving the Tuner, at once
    when switched off, and 3.04 s after Stop; with the setting off there was
    no layer and no canvas in 8 readings. Ripples with Lighten and Petal
    Mandala with Color were each still set after closing the app and
    starting it again.
- Screenshot sweep at 1024x640, 1280x800 and 1920x1080 in dark, and at
  1280x800 in light: 72 pictures of 18 screens, each looked at. Nothing
  overlaps and nothing is off screen. The sweep found the About page still
  reading 0.1.12 and an empty star that did not show on a light theme's My
  Playlists card; both were corrected, and About, My Playlists and Favorites
  were pictured again on the final files: About and Settings read 0.1.13,
  and the star shows in both themes. The cosmetic points found are listed
  under Boundaries.
- Dragging Favorites cards in the real window: 14 drops, every one in the
  expected order (on the picture, the title, the lower-right corner, the tag
  button, Move down, Move to top and the star; from above and below; onto
  neighbors and far cards). 308 drag-over events, all "move", none "none".
  Drops in a gap and on the card itself changed nothing. With the Radio
  filter, 3 drops were right and the TV favorites kept their places. A
  dropped playlist file was imported, with no reorder. With a real mouse the
  move cursor showed everywhere and a real drop worked.
- Tuner and Grid with Radio Browser made to answer 502: the same view
  reloaded kept its 80 stations, and the status line said one source could
  not be refreshed and its earlier list was kept. An empty dial tried again
  at 8.0 s and 28.1 s, then showed its final message and tried no more; with
  the source answering again, the second try loaded the dial. The Grid kept
  its 100 tiles, tried again at 8.0 s and 28.1 s and loaded by itself.
- Refused pictures: three private addresses put into the directory's answer
  were each refused once in the session and not asked for again in the next
  four visits.
- Now Playing in the real window: the empty state and its two buttons; a
  renamed favorite with a category showed its name, its original name, the
  category, the song with Star and Copy, and the stream details; a song
  starred there arrived in the starred songs; the meter moved; "Playing for"
  did not count a 66 s pause; a TV channel and an Internet Archive item
  showed no song part; three quick changes ended on the last station; the
  top bar at 1001 pixels wide kept "Sleep 119:54" on one line; leaving the
  tab removed it and its meter canvas. The small texts in light themes read
  5.59:1 to 7.37:1 against the picture.
- "Did not play last time": two stations with addresses that do not exist
  were marked within 0.5 s, with the right tooltip and details sentence; a
  working station was not marked; Play on a marked station tried it at once;
  Stop during a start left no mark after 35 s; the marks were kept across a
  restart and were gone after Clear cache; the Tuner strip kept its scroll
  position and focus when a mark arrived.
- Station pictures: choose, replace (the question named the file; No and
  Yes both did what they say) and remove; an SVG and a fake PNG were refused
  with plain reasons; a drop on a card and a drop on empty space each showed
  their hint; a dropped playlist file was still imported. The station-images
  folder held 2 files and no temporary files.
- Song title: 14.1 px at 1024 pixels wide, 15.3 at 1280 and 18.1 at 1920,
  weight 600 in the full text color, ending in an ellipsis at every size.
- Live and recorded media in the player bar, sampled about every 90 ms: a
  live TV channel played after 5.5 s with the time from 0:00 and no seek bar
  or "--:--"; live radio the same; after a station failed to start, no seek
  bar and the time at 0:00, with "This station's address does not exist.
  Press Play to retry." and Play still in the bar (one press, one
  registration; two presses in the same instant, one request); Record grayed
  with "Recording is available once this item plays." and usable again on a
  working station. An Internet Archive item showed its seek bar in all 38
  samples, disabled with "--:--" until 2.5 s, then 1:05:06; a click in the
  middle moved it to 32:34. An MP3 in a playlist kept its seek bar and read
  "This stream can be recorded."; live radio read "Live media can be
  recorded."
- The wide live layout: with live radio the song had 364 pixels at 1024
  pixels wide (136 before), 524 at 1280 (204) and 1165 at 1920 (545), with
  nothing overlapping or leaving the bar; live TV the same. Live to recorded
  and back at 1920 changed the layout once per change of item (147, 412 and
  262 samples). At 1000 pixels and below the bar stacks in rows, with
  nothing overlapping.
- Logos: a wide station logo showed whole in the player bar's square and in
  the details panel, with no initials behind a transparent logo there or on
  Now Playing; a film's picture still filled its box.
- Profile saves while the catalog loaded: 8 of 8 saves answered, and no
  notice showed. A podcast episode started while the list was loading:
  registered at once, first sound after 3.0 s with five slow outside
  requests open (27.8 s before the change).
- Sleep timer: the menu showed the running choice; a custom 45 showed
  "45 min"; an empty answer or Cancel left the running timer going; a custom
  15 selected the listed 15 min; a custom 1.24 showed "1.2 min" and started
  at 1:12.
- Start-up tidy: a name left from a station that was no longer a favorite
  was gone after a restart, and a favorite's own name was kept.
- Local port change: a renamed favorite had its name back after the port
  changed twice, with v0.1.11 run in between.
- Cards and small style points at 1024x640, 1280x800 and 1920x1080 in dark
  and 1280x800 in light: long names on two lines with an ellipsis, rows of
  equal height, nothing over the buttons; source badges whole on one line;
  sidebar source names in full; both links in the app's link color; "Heat
  Haze" on one line; the Visualizer panel at 0.98 opacity.
- Visualizer behind the Tuner, in the real window: off by default, and with
  it off no layer, canvas or Visualizer script; on before the notice,
  nothing; after the notice it showed in 0.12 s at 0.08 opacity, went within
  0.01 s of leaving the Tuner or switching it off, and 3.09 s after the sound
  stopped; faint in both themes, the text contrast within 0.2 of the Tuner
  without it. With Mandelbox Flight chosen, Plasma was drawn behind the Tuner
  and the Visualizer kept Mandelbox Flight. On the measuring page, each
  Light scene drawn as the background draws it (Low, 1003 x 531, 30 frames a
  second in real time for 30 s): Voronoi Cells 6.9 and Plasma 7.7 percent of
  one core, 0.1 ms of the graphics card a frame.
- Visualizer overlays in the real window: Ripples, Fireflies and Orbits at
  29.7 to 29.9 frames a second at Medium and High, at most 1.3 percent of
  frames over 50 ms; Lighten on Ripples and Color on Petal Mandala kept
  across a restart; Extra glow on Petal Mandala at High, 30.1 frames a second
  off and 29.8 on; Slow drift with two overlays for 60 s, no jump (largest
  step 3.9 of 255). On the measuring page, each new overlay's own drawing
  time at Medium and High: Ripples 0.52 and 0.69 ms a frame, Orbits 1.24 and
  1.18, Fireflies 2.48 and 3.43; Extra glow adds 0.02 to 0.08 of one core.
- Visualizer panel: "Under the effects" grayed with "Not available for this
  overlay." for Fireworks, Lasers, Stage Lights, Lightning and Spectrum, and
  usable for Bokeh Lights and Starburst; Spectrum with Screen draws; the
  one-blend line shows and clears; "New effects now" at the panel's 12 px.
- The released scenes in the real window, at Medium with music, 60 s each:
  103 scenes in the list (32 Light, 23 Medium, 48 Heavy), without the three
  density labs and Hypercomplex Slice Flight. DIFS Tunnel Flight 29.6 frames
  a second, Quaternion Julia Flight 29.5, Fourier Epicycles 29.9 and 4D
  Polytopes 28.9 (the tab set to 30). Quaternion Julia Flight grayed 15
  effects with the note and left its 24 calm ones usable. Fourier Epicycles
  and 4D Polytopes offered Neon, Ember and Rainbow and did not go dark with
  Slow drift on (mean brightness 15.8 to 30.1 of 255). Mandelbrot offered
  Neon and Ocean, and their colors moved.
- Voronoi Cells: Mirror grayed with the note; 15 presses of "New effects
  now" never chose it. A Mirror ticked on Starfield showed ticked but grayed
  on Voronoi Cells, and was still ticked back on Starfield.
- Mood in the real window, one reading per station: a classical station read
  steady for its first 4 s, then calm (energy median 0.065); a pop station
  steady for 82 s, then energetic (median 0.53); a drum and bass station
  during a talk-led show steady (median 0.40). The brightness reading
  (`data-bright`) was -37 to -52 dB, within the range of the recorded clips.
- Mood on sixteen recorded three-minute clips of eleven stations, replayed
  through a copy of the page's analyser; the share of readings with the
  right word at 30 and at 15 frames a second:
  - calm music: ambient 100 and 100 percent, classical 93 and 91;
  - steady music: jazz 94 and 100, pop 100 and 100, rock 100 and 100, deep
    house 84 and 94, hip hop 100 and 100;
  - energetic music: metal 93 and 93, trance 74 and 69, drum and bass 74 and
    69, hard techno 47 and 47;
  - five clips kept aside while the rule was chosen: ambient 95 and 100, pop
    62 and 63, metal 27 and 50, drum and bass 70 and 11, trance 18 and 7.
  At 20 and 25 frames a second every clip the rule was chosen on stayed
  within 15 points of its share at 30. Calm music never read as energetic in
  any run. With the whole spectrum 6 dB louder or quieter, every reading was
  the same.
- Brightness-step check (the flash check in `tests/helpers/`), on the
  graphics card, each overlay at its strongest, on Voronoi Cells (bright),
  Starfield (dark) and Plasma (calm): no step over 0.10 of full brightness
  from one frame to the next, and no swing of more than 0.10 three or more
  times a second in any run.
  - Ripples, Fireflies and Orbits, plain and with every blend they allow,
    over and under: largest step 0.0670, against Plasma's own 0.0669 (90
    runs).
  - Lighten and Color with the brightest overlays and Strobe: largest step
    0.0667 and 0.0670; Lighten at most 0.026 above the scene's own step,
    Color at most 0.0001 (156 runs).
  - Extra glow, on against off: 0.0669 either way, at most 0.0003 above the
    same run without it, and the picture's mean never brighter (178 runs).
  - Slow drift of overlay settings over a whole drift cycle at its deepest:
    0.0789 on and off, at most 0.0019 above; every setting stayed in its
    range and within its depth (78 runs).
  - Overlay sizes by the picture's height: 0.0678 with it as without it (232
    runs).
  - Everything on together (sizes, glow, drift), line overlays at High, in
    1920 x 1080 and 1080 x 1080 windows: largest step 0.0791, against
    Plasma's own 0.0790 (228 runs).
- Overlays under the effects, with the effects drawn:
  - Under Mirror in its Kaleidoscope mode and Swirl, both strong: Fireworks
    stepped by up to 0.191, Lasers 0.152 and Stage Lights 0.105; Bokeh
    Lights, Tron Hex Grid, Triangle Grid, Starburst and Strobe at most
    0.0986, against the effects' own 0.0953 (165 runs).
  - Under Kaleidoscope alone: Spectrum 0.112 on Starfield, where the effect
    alone stepped by 0.022, and Lightning 0.115 on Voronoi Cells, where the
    effect alone stepped by 0.102. Every other overlay stayed within 0.005
    of the effect's own step on Voronoi Cells and at most 0.030 on Starfield
    (298 runs).
  - Under Edge Glow and ASCII Text Mode, the two effects that change the
    picture's mean most: largest step 0.0535, against Edge Glow's own 0.0522
    on Starfield (170 runs).
- The four released scenes and two looks, over 360 s of each scene's clock
  at its speed cap, with the surge at its most: Quaternion Julia Flight
  0.0747 (so it takes only calm effects), DIFS Tunnel Flight 0.0244, neither
  near black; Fourier Epicycles' three looks 0.0081 at most (0.0101 with
  drift), under a mean brightness of 0.05 for 0.4 s at most; 4D Polytopes'
  three looks 0.0139 at most (0.0190 with drift), never under 0.05;
  Mandelbrot's Neon 0.0485 and Ocean 0.0478, never under 0.05. Still held:
  FLAM3 Density Lab's own look sits under 0.05 for 5.0 s, IFS / L-System
  Lab's for the whole 30 s and Attractor Density Lab's for 2.5 s from a cold
  start; Hypercomplex Slice Flight steps by 0.42 to 0.65.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,653,353 | `E7812DAB8C4F72704224C638877B982F4005C1877D5F71295313C260772430DB` |
| `WorldMediaWindows-0.1.13-portable.zip` | 15,423,744 | `CEAC14CB31C890C9D9E4295A964E13CB18DE6F949C1FA5A97FA206C9CAEB1E3F` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- "Did not play last time" shows only on your own stations (favorites and My
  Playlists), and only after a station was tried and did not play. The marks
  are kept in the app's cache, not in the profile or backups; Clear cache
  removes them.
- To tell a station that is down from a connection that is down, the app may
  make one small request to Radio Browser, at most once every 30 seconds,
  when a station could not be reached and nothing outside answered in the
  last minute.
- A station listed as live whose stream, played directly, reports a finite
  length that keeps growing shows a seek bar for about its first ten
  seconds.
- The large meter on Now Playing moves with the sound whatever the "Sound
  meter in the player bar" setting.
- The Visualizer behind the Tuner draws Light scenes only (Plasma in place of
  a chosen Medium or Heavy scene), without overlays or effects, at Low
  quality.
- The mood is read from the spectrum and still changes with what is playing.
  At 15 frames a second fast, dense music such as drum and bass can read as
  steady, and some energetic music reads as steady at any frame rate. After
  the tab opens or the station changes, the line keeps its last word (steady
  when the tab opens) for the first seconds, until the new reading is ready.
- Three density labs (FLAM3 Density Lab, IFS / L-System Lab and Attractor
  Density Lab) and one 3D flight (Hypercomplex Slice Flight) from
  Psychedelia Studio are not offered: the labs start too dark, and the
  flight's brightness steps too far from one frame to the next.
- Fireworks, Lasers, Stage Lights, Lightning and Spectrum always stay over
  the effects.
- Voronoi Cells takes no Mirror.
- On a picture under 720 pixels tall (Low quality, or a small window), an
  overlay's lines are drawn larger than at Medium and High.
- At 1024x640 the details panel's **Other streams**, **Rename** and **Choose
  picture...** buttons are reached by scrolling the panel, and the Tuner
  dial's station name and long titles end in an ellipsis. In a light theme
  the Visualizer's panel stays dark.
- An empty Tuner dial or Grid tries again by itself twice; after that,
  pressing **Radio** or **TV** (in the Grid, **Live TV** or **Radio**) loads it
  again.

The v0.1.12 boundaries still apply, except these, done in this release: long
station names on Favorites cards, which now take two lines; long source names
in the Library sidebar, now shown in full; the color of the two links; the
empty Tuner dial, which now tries again by itself; and the mood following the
drums and the tempo, which is now read from the spectrum.
