# v0.1.16 release verification - 2026-11-23

Release scope: the stream format and bitrate of stations that have played; a fix
for live AAC streams that started in the middle of a sound frame; live audio
passed on as it arrives; a compact volume control; a one-row player bar; the
mouse wheel over the Tuner's station strip and a strength control for the
Visualizer behind the Tuner; one running copy per data folder. See [release
notes](RELEASE_NOTES_0.1.16.md).

## What changed and why

- **The format and bitrate were known only for stations a directory lists.**
  Reported by TaxicabMessiah in
  [issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6): with
  **Show technical source details** on, a station imported from a playlist
  showed nothing, because only Radio Browser lists a format and bitrate. When
  the relay opens a plain live audio stream it now reads the audio
  `Content-Type` and the `icy-br` header of the station's reply
  (`stream_facts` and `note_stream_facts` in `worldmedia_server.py`; kept on the
  playback root by `MediaRegistry.note_stream_facts` in `worldmedia_media.py`),
  and the now-playing reply that the page already polls carries them as
  `stream`. The page remembers them for the station once the start has played
  for a second (`src/lib/played-streams.js`, key `worldmedia.playedstreams.v1`,
  at most 1,000 stations, the oldest go first; a start that does not play
  records nothing). Nothing is probed or asked for, so no request is added. They
  show as "Stream: AAC+ · 320 kbps" in the tooltip of a station in the Library
  and the Tuner, as a tag in the details panel and, with **Show technical source
  details** on, on the Library card and in a short form on the Tuner card
  (`src/modes/library/render.js`, `detail.js`, `src/modes/tuner.js`). What a
  directory lists is shown as before; a played value only fills in what the
  listing leaves out, and only when the two do not disagree. They are a cache:
  not in the profile files or backups, and removed by **Clear local cache**. The
  description of the setting in Settings was rewritten (`src/lib/settings.js`).
- **Live AAC streams that started in the middle of a sound frame.** A Shoutcast
  server starts a new listener wherever its buffer is. When that is inside an
  AAC frame, the browser engine can fail to decode the start and the player
  stops with a decode error. On Radio Caprice - Trip Hop, the station from issue
  #6, about one start in five or six failed this way; v0.1.14 and v0.1.15 did
  too. `AdtsAligner` in `worldmedia_icy.py` now holds the first bytes of a live
  AAC stream (`audio/aac`, `audio/aacp`, `audio/x-aac`, `audio/x-aacp`; a GET
  from the start of a playback root, answered 200 with no length, range or
  content encoding; never a capture job's) until it finds the first frame header
  that the next two headers confirm, each right where the one before says it
  ends and all with the same fixed fields. It drops the bytes before that header
  and passes everything after it unchanged. If no such frame is found within
  64 KB or 1.5 seconds, or the stream ends first, what it holds is passed on
  unchanged. Other formats are not touched.
- **Live audio waited for 64 KiB.** A live audio reply without a length was
  relayed in full 64 KiB reads, and a 64 KiB read holds a 32 kbps stream for 16
  seconds before the player gets anything. `relay_passes_as_available` in
  `worldmedia_server.py` now passes such a reply on as it arrives: a GET of a
  playback root (not a capture job's, not a DASH template) answered 200 with
  `audio/*` or `application/ogg` and no length or range. Files with a length,
  video, manifests, segments, ranged replies and HEAD keep full reads. On four
  stations that take this path the first bytes came 0.3 to 0.5 s sooner.
- **The volume slider was wide.** It is replaced by a compact control
  (`src/lib/volume-stepper.js`, the markup in `src/index.html`, the styles in
  `src/styles/base.css`): the speaker (mute) button and, beside it, a column of
  an up button, the volume as an LED-style number and a down button; in a
  window 1000 px wide or narrower, a row of its own (down, number, up). A click
  changes the volume by 1; holding a button repeats after a 0.4 s pause, one step
  every 50 ms (about 14 steps in the first second, measured as +14 after holding
  1.0 s), with one timer at a time, so a busy moment does not bring a burst of
  steps; the mouse wheel over the control changes it by 2 per notch; with the
  control focused, the arrow keys change it by 1, Page Up and Page Down by 10,
  and Home and End set 0 and 100. The volume area of the bar is 69 px wide where
  it was 138. A hidden input still holds the user's level for
  `src/lib/player.js`. Two related changes: changing the volume or mute with a
  video's own controls now sets the bar's number, the speaker icon and the saved
  volume (`adoptElementVolume`; the volume part is ignored during a sleep-timer
  fade), and a volume set during a sleep-timer fade is the level that comes back
  when the timer ends or is cancelled.
- **The Tuner's station strip ignored the wheel, and the Visualizer behind the
  Tuner had one strength.** The wheel over the strip of station cards now goes
  to the dial's own wheel handler (`src/modes/tuner.js`): the same station per
  notch and the same tune once it rests; a mainly sideways wheel or swipe counts
  too. The new **Visualizer:** control at the right of the top bar is the volume
  control laid in a row. Its number is the picture's opacity in percent
  (`tunerVisualizerLevel`, 1 to 100, inside the existing settings value;
  `src/lib/tuner-background.js`, `src/modes/tuner-background.js`), so 8, the
  default, is exactly the 0.08 opacity it had before and 100 is no dimming. 0 is
  the existing switch off (`tunerVisualizerBackground`): turning the number down
  to 0 switches it off, pressing up from 0 switches it on at 1, and the Settings
  switch and the control follow each other. Switching off in Settings keeps the
  level; turned down to 0 on the Tuner, the level comes back at 8. A level above
  0 only changes the picture's opacity, and the Visualizer in it is not started
  again. The notice about flashing pictures, the flash limiter, the Light
  scenes, Low quality and 30 frames a second are the same at every level, and
  nothing is drawn before the notice has been accepted.
- **The player bar was two rows tall.** In a window wider than 1000 px it is one
  row with every control on one centre line, 74 px high where it was 96 (168
  where it was 198 in a window 1000 px wide or narrower, where its rows are
  stacked). The line of text under the buttons is gone. A standing hint is the
  **Record** button's hover text and its accessible description
  (`aria-describedby`): "Live media can be recorded.", "Recording is available
  once this item plays." and, with Recorder off, "Recorder is off, so playback
  has priority. To record, turn on Recorder in Settings (the gear at the top),
  under Capture & storage." A capture's progress, result or error (`notice` in
  `src/lib/capture-view.js`) shows beside the button. The **Open Settings**
  button, which appeared beside the Record button with Recorder off or after a
  failed capture, is removed; the gear at the top opens Settings. A Record
  button that only carries a hint is `aria-disabled` and stays in the tab order,
  so the keyboard can reach its hover text and description; a press does
  nothing. The **EQ** button has one width in every state, so the bar does not
  shift.
- **A second start opened a second window.** `worldmedia_single_instance.py`
  makes one copy run per data folder. `main()` in `worldmedia_native.py` works
  out the data folder and claims it, a Windows named mutex whose name holds a
  hash of the normalised folder path, before anything is written, migrated or
  listened on. A start with a window that does not get it asks the running copy,
  through a named event that carries no data and no session token, to bring its
  window to the front (restored if minimized), and exits. If the running copy has
  no window to show (it is closing), the start waits up to 15 seconds for the
  folder and then starts as usual. A start without a window
  (`WORLDMEDIA_NO_BROWSER=1`) on a folder in use prints one line and exits with
  code 3. Copies with different data folders get different names and run side
  by side. The operating system removes the mutex when the process ends, so a
  crash or a kill leaves no lock, and the running copy holds it until its
  shutdown has finished.
- **A test that could end the test run.** A test in
  `tests_python/test_control_api.py` left its patch of the exit scheduler before
  the server's handler had called it, so on a busy computer the real scheduler
  could end the test process early. The test now waits for the call, up to five
  seconds.

## Evidence

- `npm test`: 1,788 passing JavaScript tests (54 more than v0.1.15).
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 701 tests,
  694 passing and 7 skipped (46 more than v0.1.15). The new ones cover the AAC
  frame alignment and the as-it-arrives relay, the stream facts in the
  now-playing reply, and the one-copy claim (a second claim, the request to
  bring the window forward, a killed copy, racing starts, a mutex or event that
  the process may not open, and the window and windowless starts).
- `python -m ruff check --select F,E9 .`: clean. `npm audit
  --audit-level=high`: 0 vulnerabilities.
- `npm run build`: succeeds with the existing dash.js warnings.
- Build commands: `python build_windows.py --skip-frontend` and
  `python build_single_exe.py --skip-frontend`.
- Radio Caprice - Trip Hop: a saved start that failed 3 times out of 3 in the
  window's browser engine played 3 times out of 3 once aligned. In the real
  window of the release build 12 of 12 starts played, ten of them with sound
  after about 1.3 s.
- The stream format, in the real window of the release build: after a playlist
  station (Radio Caprice - Trip Hop) had played, its Library card showed "AAC+ ·
  320 kbps" with **Show technical source details** on, its tooltip showed
  "Stream: AAC+ · 320 kbps", and its Tuner card showed the compact form; the
  value was kept after a restart.
- Other playback in the real window of the release build: one MP3 station, two
  AAC stations, one HLS station and a media.ccc.de video played, and a
  recording was saved.
- The volume control, in the real window of the release build at 1024x640,
  1280x800 and 1920x1080: a click, a held button, the wheel, the keys, the
  limits at 0 and 100, mute, and the level kept after a restart. The volume
  followed a drag of a video's own volume slider.
- The Tuner, in the real window of the release build: the wheel over the station
  strip; the **Visualizer:** control at several levels, 0 and turning it on
  again, after a restart, and with the notice not yet accepted (nothing drawn).
  Processor use at level 8 and at level 100 was the same: 22.0 % and 21.9 % of
  one core.
- One copy per data folder, for the one-file EXE and the portable folder: two
  starts within a second, the window covered by another window, minimized,
  closed and started again, after a killed process, with different data
  folders, and a windowless start.
- The player bar at the three sizes: its height and that every control sits on
  one centre line.
- Final release files, on the test machine:
  - The one-file EXE, started without a window, answered its health check in
    4.4 s, served the page and all 131 frontend files byte for byte, answered
    403 without the session token, and exited with code 0 after shutdown.
  - The portable ZIP has 572 entries (515 files) under one top folder, no
    unsafe names, the three WebView2 loaders, 131 of 131 frontend files and
    21 of 21 server modules identical to the repository, and no user data,
    logs, downloads or tools. Its extracted copy passed the same checks as
    the EXE (health check in 3.3 s, exit code 0).
  - Started in a window with every file marked as downloaded from the
    internet: the portable folder showed its window after 6.3 s and the
    one-file EXE after 5.8 s; both exited with code 0 when the window was
    closed.
  - In the real window, About and Settings read v0.1.16 and all seven tabs
    are present. A playlist station that showed no stream details showed
    `MP3 · 128 kbps` on its card and `Stream: MP3 · 128 kbps` in its tooltip
    after one play.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,688,823 | `FA412748CED9DF06B96765D2570BD044F5923EDD94267299910898DB07D61186` |
| `WorldMediaWindows-0.1.16-portable.zip` | 15,447,987 | `ADA69AEADE0792FAFD01AA323A0B4430F6311B4D011A4886807E188950776CE1` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

Known limits in this release:

- A station shows its stream format and bitrate after it has played once,
  unless its directory lists them. A station delivered as HLS shows none, and
  neither does a station whose server sends neither an audio type nor a
  bitrate.
- A live AAC stream for which no whole frame is confirmed in the first 64 KB or
  1.5 seconds starts as before.
- A second start made at the very moment the running window is closing may open
  nothing; start the app again.
- The one-file EXE takes a few seconds before a second start hands over,
  because it unpacks first.
- Above the default level of 8 the Visualizer behind the Tuner can make text on
  the Tuner harder to read; the level is the user's choice.

The v0.1.15 boundaries still apply.
