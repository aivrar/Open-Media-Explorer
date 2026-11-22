# Architecture and runtime reference

## High-level flow

```text
Windows EXE
  └─ bundled Python launcher (worldmedia_native.py)
      ├─ 127.0.0.1 HTTP server (worldmedia_server.py)
      │   ├─ static Vite frontend
      │   ├─ authenticated catalog/control API
      │   ├─ HTTPS/DNS-pinned catalog boundary
      │   ├─ opaque artwork relay
      │   └─ opaque media/HLS/DASH relay
      └─ WebView2 desktop window
          ├─ Library / Tuner / Grid / Discovery / Visualizer / About
          ├─ catalog scheduler and adapters
          ├─ global player + HLS/DASH engines
          ├─ artwork queue
          ├─ EQ audio graph
          └─ capture/download clients
```

The app is not a cloud service. The Python process is local and the browser
front end calls it through an authenticated same-origin control session.

## Catalog orchestration

`src/lib/catalog-scheduler.js` owns catalog task slots. It provides:

- eleven global slots, shared by one lane per registered source by default (the
  app has ten sources; a few providers allow a second lane or more);
- two of those slots that background work (prefetch and snapshot refresh) never
  takes, so what the user is looking at can start at once;
- provider-specific maximum concurrency and minimum start intervals;
- priority classes for user work, initial browse, search, snapshots, and
  prefetch;
- deduplication by `(source, key)`;
- per-source exponential cooldown for transport/408/429/5xx failures;
- bounded queue size and task timeout;
- cancellation when a source is disabled, a generation is replaced, or the
  mode is hidden;
- playback priority that reserves slots for media without abandoning background
  work.

Library finite browsing has one cursor/progress record per enabled source. Only
`exhausted: true` retires a cursor. Errors preserve the cursor and mark the
source retrying/rate-limited. Snapshot adapters have a separate refresh manager
so a live empty snapshot cannot complete a VOD archive. A live list is read
the first time whichever Library view is open, and until it has arrived once
its retries do not wait for a view that shows it; after that it is refreshed
only while it is shown.

Requests to the catalog providers pass a gate in `src/lib/http.js`: at most
four are sent at a time, and a request waits for its turn before its time
limit starts, because the embedded browser gives the local server six
connections that pictures, the playing stream and the page's own calls share.
The server asks the providers for gzip and passes it through.

## Catalog state and rendering

`src/modes/library/catalog-store.js` merges stable item IDs, retains source/type
counts, and pins favorites/current/detail items. `src/modes/library/render.js`
filters the resident pool and mounts a maximum 300-card render window. The
window expands/rewinds independently of the resident pool. This separation is
why a large session can remain searchable without a 40,000-card DOM.

Artwork uses a deduplicated retry queue. Visible cards get high priority; nearby
cards are prefetched; off-screen cards wait. A provider URL is converted into a
short-lived opaque local asset registration before it is attached to an image.

## Playback and relay boundary

`src/lib/media-failover.js` normalizes up to eight stream candidates and probes
two at a time. The first working candidate wins; losing relay registrations are
expired. `worldmedia_media.py` validates redirects, DNS/public addresses,
content types, byte ranges, and manifest sizes. HLS/DASH manifests are rewritten
to local opaque child resources.

Every outbound connection is made to an address from the validated lookup of
the host. Since v0.1.15 the addresses are tried together: IPv4 first, the next
address a quarter of a second later (at once when an attempt fails outright),
and the first that connects is used; the whole attempt has one time limit of
eight seconds. The address that answered is tried first for that host for the
next ten minutes. Before, the addresses were tried one after another, each
with the full time limit.

With **Pick the best stream** on **Listed streams** (the default) or **Auto
(verified)**, `src/lib/best-stream.js` first ranks the listed streams by what
the directory reports (TV by picture size, radio by bitrate up to 320 kbps,
then format), and the best one gets a head start of six seconds
(`BEST_STREAM_HEAD_START_MS`) before the next is probed beside it. With
**Off** the first two candidates are probed together, as before 0.1.12. In
every mode `src/lib/start-failover.js` hands a stream that connected but never
began to the candidates not tried yet, at the latest after 30 seconds; a
stream that has begun gets 10 seconds (`START_CONFIRM_MS`) from its first
`playing` to play one full second.

`src/lib/player.js` owns the single audio/video pair, ownership generations,
rapid-switch cancellation, relay lifetime, HLS/DASH cleanup, Web Audio EQ,
media-session controls, and the player bar. A failed media element is rebuilt on
Play rather than repeatedly poked after an error, and so is one whose stream
ended. A plain live stream (`stream_kind` audio or video) whose element ever
reported an unbounded duration is marked `playSession.unbounded`; its `ended`
event (the station closed the connection) is taken as a lost connection and
reconnected by `src/lib/live-resume.js`, even though the element reports the
time played as its duration just before the end.

**Auto (verified).** `src/lib/best-stream-auto.js` runs the checks and
`src/lib/stream-verify.js` holds the rules. Nothing is looked up before a
start. After about 45 seconds of playing (`VERIFY_AFTER_MS`, counted from the
first `playing`, again after a pause), it looks up other Radio Browser entries
of the station (`src/lib/stream-lookups.js`, under the station's own name) and
keeps those with the same name, homepage host and country, on the same stream
site, plain audio, https when the station's stream is https, passing the
directory's last check, unchanged for 30 days and with at least 3 votes or 20
clicks, and better by the ranking. The local server then opens both streams
for a short look (`POST /api/v1/streams/probe`, `worldmedia_stream_probe.py`:
one pair at a time, one deadline for everything, only the content type,
`icy-br`, `icy-name`, `icy-url`, the first song title, the byte count and the
final scheme and host are returned). A first match is pending; a second match
on a different song at least four minutes later (`MIN_MATCH_GAP_MS`) verifies
it for seven days. At most two probes run per station a week. Pause, stop,
another station or leaving Auto aborts a check, and its result is dropped.
Results are kept in `worldmedia.streamverify.v1` and lookups in
`worldmedia.streamlookups.v1` (caches, removed by Clear cache); the stations
kept on their own stream are in `worldmedia.ownstream.v1`, a profile key.

## Sound meter

The player-bar meter is built in three layers, so that a later visual can
share the same reading:

- **Visual side tap** (`src/lib/audio-engine.js`): `visualTapFor(element)`
  makes a second `AnalyserNode` (`VISUAL_ANALYSER_SETTINGS`: FFT size 2048,
  -85 to -15 dB, no smoothing) fed from the same point as the EQ analyser (the
  sum of the dry and wet paths, so after the EQ curve and its limiter). It is
  connected to nothing, so it changes neither what is heard nor what
  `verifySignal()` measures. It is made only for an element that is attached
  to an existing graph whose context is already running; it never creates the
  graph or the context and never resumes a suspended context (that stays tied
  to the user's Play). `releaseVisualTap()` disconnects it.
- **Shared signal** (`src/lib/audio-signal.js`): one loop reads the tap once per
  frame into one frame object (byte spectrum, waveform, RMS level, bass, mid
  and high levels, and log-spaced bars on request) and hands it to every
  subscriber. It runs only while there is a subscriber, something plays, the
  sound is audible (not muted, volume above 0) and the document is visible;
  otherwise nothing is scheduled and the tap is released. It is paced by a
  timer at the fastest rate a subscriber asks for, and each tick asks for one
  animation frame, so it does not run at the display refresh rate. With no
  readable tap it looks again every 250 ms on a plain timer.
- **Meter** (`src/lib/player-meter.js`): 14 bars from 40 Hz to 16 kHz with a
  3 dB per octave tilt, a boost-only auto-gain (up to 18 dB overall and 6 dB per
  band), attack, release and peak hold, drawn on a 90 x 36 px canvas in whole
  device pixels (10 to 12 segments, depending on the display scale).
  It asks for 15 frames a second and redraws its canvas only when a lit
  segment changes. It listens only while the setting is on, its canvas is laid
  out, and reduced motion is not requested.

`src/lib/player.js` gives the signal a tap only while the active element plays
through the relay (`activePlaybackRelayed`) with no playback problem, and
refreshes it on `playing-change` and on `volumechange`. Playback that falls
back to direct, cross-origin media (no relay, EQ unavailable) has no tap, and
the meter stays flat. `src/index.html` holds two meter blocks, one for the wide
player bar (in the progress row, shown only when that row is at least 330 px
wide) and one for the stacked bar at 1000 px and under (at the end of the
button row, giving way before any button); CSS lays out at most one, and only a
laid-out one listens.

## Visualizer

`src/modes/visualizer.js` is a thin shell in the main bundle. The first time the
tab opens it imports `src/visualizer/visualizer.js`, a separate chunk that holds
`src/visualizer/index.js` (the panel and the wiring) and its styles. Each scene
is a further chunk, fetched when it is chosen or prepared ahead. The effects
library and the overlays are loaded the first time they are switched on.
`mountVisualizer()` returns `destroy()`, which stops every timer and frame,
drops the sound subscription, removes every listener and gives the WebGL context
back. Leaving the tab calls it, so a closed tab costs nothing.

- **Sound.** The loop subscribes to the shared signal
  (`src/lib/audio-signal.js`) at the chosen frame rate and asks for the float
  spectrum. Each subscriber is paced on its own, so a 60 frames a second visual
  does not make the 15 frames a second meter run at 60. A frame also carries
  `version` (it changes with a new item or media element, so tempo tracking
  restarts then and not on a pause), `tapVersion` and `volume`. `reactor.js` is
  the port of Psychedelia's Beat Reactor: it turns the frame into kick, snare and
  hat hits, tempo, the beat clock and the mood (`mood.js`) that the scenes and the
  shuffles use.
- **Flash limiter** (`src/visualizer/flash-limiter.js`). Every sound-derived
  value a scene gets passes it. At most three large pulses reach the picture in
  any rolling second, counted together over every channel, the beat clock,
  trigger effects, overlay hits and scene changes. No pulse is deeper than 0.6,
  and levels and speed may swell but not snap. The window is kept for the page,
  so closing and opening the tab does not start a fresh second. It limits the
  sound values a scene is given. It does not look at the picture, so each scene,
  look, effect and overlay is also checked by hand with the flash-check scripts
  (see the developer guide). A scene that fails is held back in
  `HELD_SCENES` (`scenes.js`) and is not offered.
- **Drawing.** `scene-renderer.js` draws one scene at a time on a WebGL
  canvas, with the uniforms Psychedelia's own renderer feeds. Most scenes are
  one shader pass. Since 0.1.12 some own their passes: the simulations and
  Feedback Loop through `sim-host.js` (each offered only where the context can
  make the render targets it needs), the line drawings through `line-host.js`,
  and Buddhabrot Lab, which builds its picture in one worker
  (`density-host.js`), with a bounded share of one core and the worker ended
  when the picture is done or the scene goes. Each has limits per quality on
  what it builds a frame, and everything a scene makes is freed when it
  changes, the tab closes or the context is lost. World Media's own scenes are
  in `src/visualizer/own/`. `drift.js`, `swell.js` and `overlay-motion.js` give
  **Slow drift**, `mood.js` the mood (hits merged across bands, hi-hats at
  half, tempo from 80 beats a minute), and `spelling.js` shows names from the
  copied code in American spelling (saved values are unchanged).
  `fx-chain.js` runs the post effects over it and is bypassed while none are on.
  `overlay-layer.js` draws the Canvas 2D overlays on a second canvas laid over
  the picture. One overlay at a time can be uploaded and blended into the
  picture by the chain. `transition.js` cross-fades every visible change.
- **When it draws.** `loop.js` draws inside the signal's frames at the chosen
  rate while sound plays. With nothing to hear it draws at 5 frames a second for
  20 seconds, then holds the last picture and schedules nothing. Nothing is
  drawn while the document is hidden, or before the photosensitivity notice is
  accepted.
- **Step-down.** `step-down.js` measures only the intervals between drawn frames
  (nothing is read back from the graphics card). After two 3-second windows in a
  row below 80% of the chosen rate (or of the display's), it takes one notch:
  effects, then overlays, then quality, then frame rate. It belongs to the scene
  shown, and the saved settings are not touched.
- **Processor use.** `src/lib/processor-budget.js` holds the level
  (`processorUse`: `light`, shown as **Low**, the default; `balanced`; `high`)
  and the limit (`processorLimit`, 2 to 80 in steps of 1; `null` means the
  level's start, 40 or 60). At Low nothing is read and only the frame-time
  step-down applies. At Balanced and High, while the Visualizer plays and the
  tab shows, the page reads `GET /api/v1/system/processor-use` every 3 seconds
  (`worldmedia_processor.py`: the processor time of the app's process tree,
  the WebView2 processes included, as a share of all logical processors;
  nothing runs between requests) and smooths it. Over the limit for 6 seconds
  takes a notch off; under 0.6 of the limit for 30 seconds gives one back; no
  decision follows for 8 seconds after a change, and a notch taken off within
  60 seconds of a step-up stops further step-ups for that scene. The limit is
  a target, not an operating-system cap, so the sound is never held back. The
  higher levels also offer **Very high** (a 4.8 million pixel budget; heavy
  scenes other than those in `VERY_HIGH_HEAVY_ALLOWED` draw at High's
  budget), and High starts Curl-Noise Silk, Fluid Ink and Physarum one size up
  (`SIM_SIZES_ABOVE_HIGH`). At most three effects and three overlays stay the
  limit at every level.
- **Choosing.** `shuffle.js` picks scenes (a bag, a recent list, category and
  mood rules, the cost filter), `fx-shuffle.js` and `overlay-shuffle.js` pick
  effects and overlays within a cost budget per quality, and `favourites.js`
  stores a star as a short string: the scene, `:look`, `|effects` and `/overlays`.
- **Saved fields.** The choices are fields of the settings value
  (`worldmedia.settings.v1`), named `visualizer...` (see
  `src/lib/visualizer-settings.js`), not new profile keys or files. Since
  0.1.12 they include `visualizerDrift` (Slow drift), `visualizerOverlayStyles`
  (a Style picked by hand, such as Strobe's) and `visualizerFolded` (the side
  panel's folded sections: `scene`, `shuffle`, `fx`, `ov`, `picture`).
  `Ctrl+Shift+D` shows a developer strip with the sound values the scenes get
  (`visualizerDebug`); it is off by default and costs nothing while off.
- **Copied code.** `src/visualizer/vendor/psychedelia/` holds files copied from
  Psychedelia Studio by `scripts/import_psychedelia.mjs`, with a `manifest.json`
  of their sources and SHA-256 values. `npm test` checks them against it. The
  About page's **Visualizer credits** (`src/modes/about-credits.js`) are built
  from the manifest's `borrowed` list. `CREDITS.md` and
  `public/THIRD_PARTY_NOTICES.txt` list the same pieces, and a test checks that
  they name every borrowed piece's author and source as the manifest does.

## Tuner layout and card pictures

The dial is sized from the height the Tuner's other rows leave, so those rows
have fixed heights: every strip card has a fixed height and line height (a
name in another script no longer makes its card taller), the strip keeps its
minimum height while it shows a message instead of cards, the status line
stays on one line, and before the first play `#app:not(.has-player)
.tuner-root` keeps the player bar's height free as bottom padding.

`src/lib/tuner-card-size.js` holds the card size (`small`, `medium`, `large`;
anything else means `small`). Medium and Large set per-size CSS variables on
`.tuner-root[data-card-size]` and raise the strip's fixed minimum by exactly the
card's extra height. `src/lib/tuner-card-art.js` gives each Medium or Large
card a fixed picture box with initials, waits until the strip has not been
rebuilt or scrolled for 350 ms, then loads pictures only for the cards in view,
each once, through `artwork.js` (the user's own station picture first, then the
station's relay artwork). A card that leaves the strip stops its load; the last
120 finished boxes are kept so the dial can come back to them without a new
request.

A user's own station picture carries the `is-station-image` class (set by
`artwork.js` and the player bar only once it has loaded) and is shown with
`object-fit: contain` on a plain surface in every view, so it is never
cropped. Remote artwork keeps each view's own fit.

## Song titles

`worldmedia_icy.py` reads the song titles that Shoutcast and Icecast stations
send inside the audio. The relay asks a station for them (the `Icy-MetaData: 1`
request header) only for plain live audio playback that starts from the
beginning of the stream. It never asks for HEAD requests, DASH, HLS or video
items, on-demand items, the child resources a manifest lists, capture jobs
(FFmpeg recordings), or a host that broke when asked recently. Downloads open
their own connections and never ask.

When a station answers with a usable `icy-metaint` value, the relay removes the
metadata blocks from the body before the browser sees it, so the audio is the
same as without titles. That reply has no `Content-Length`, `Content-Range`, or
`icy-*` header, and the connection closes when the stream ends. The latest
`StreamTitle` is kept in memory for the playback relay token, cleaned to one
plain line of at most 200 characters (at most 256 tokens are remembered).
Nothing named in the metadata is ever fetched.

An old Shoutcast server (version 1) starts its reply with "ICY 200 OK" where a
web server says "HTTP/1.0 200 OK". Every outbound connection reads that first
line as HTTP/1.0, so such a station plays, records and is checked like any
other, with its titles.

If a server answers with something that is neither of those, resets the
connection, or rejects the header with a client error (400, 406, 412, 415 or
431), the relay repeats the request once without the header. A host where that
repeat works is not asked again for an hour.

The page polls `GET /api/v1/media/{id}/now-playing` about every five seconds
while it plays that token (`src/lib/now-playing.js`) and shows the title in the
player bar and the Windows media overlay. `src/lib/song-log.js` adds each new
title to the song log.

## Local port at start

`worldmedia_native.py` chooses the port (`choose_port`). A forced port
(`WORLDMEDIA_WINDOWS_PORT`) is used as it is. Otherwise it tries the configured
port (normally `9124`), then a bounded fallback range. If the preferred port is
busy and the program holding it answers `/api/health` as World Media, it waits
up to 8 seconds before trying another port, because another port would be
another browser origin with other saved favorites. It cannot tell whether that
copy is closing (a copy that was just closed keeps its port for a few seconds),
so the wait also covers a copy that is still running. A port held by any other
program is passed over at once. Checking
that a port is free and binding it are two steps, so a lost race moves to
another port (up to five tries) instead of failing. On Windows the server takes
its port exclusively (`SO_EXCLUSIVEADDRUSE`, with no `SO_REUSEADDR`), so two
copies can no longer listen on the same port and split the page's requests. The
`listening` line in `native.log` shows the port, the process id and a note on how
the port was chosen.

## Capture jobs

The frontend registers an opaque media ID; it never submits an upstream URL to a
control route. `worldmedia_jobs.py` tracks the monotonic state machine:

```text
queued → preparing → running → stopping → finalizing → completed
   └──────────────→ cancelled/failed
```

Downloads and recordings run in separate workers with validated roots and
terminal history. Downloads use atomic `.part` publication and safe resume.
Recordings use a distinct upstream relay/FFmpeg process and validate output with
FFprobe before publishing MP3 or MP4.

## Profile and security model

The server binds to `127.0.0.1`, rejects cross-origin control/preflight calls,
requires a per-process control token for mutations, and uses same-origin
authenticated GETs. Opaque media/assets expire and are not useful after a
restart. Logs redact URLs, query secrets, and media identifiers.

Catalog metadata is restricted to an HTTPS/DNS-pinned allowlist. Dynamic
podcast, PeerTube, Owncast, artwork, and media origins cross narrow semantic
resolvers with public-address validation; there is no wildcard proxy. Response
sizes, JSON/XML/M3U schemas, redirects, headers, filenames, and output paths are
bounded.

## Saved data files

World Media 0.1.8 and older treat a `profile-preferences.json` that holds a key
they do not know as unreadable and ignore all of it, favorites included. So
the data that version 0.1.9 added is kept apart:

| File | Holds | Code |
|---|---|---|
| `state/profile-preferences.json` | The five keys every version knows: favorites, settings, volume, job history, EQ | `worldmedia_runtime.py` |
| `state/profile-preferences-extra.json` | Newer keys: the favorites categories (`worldmedia.favgroups.v1`), the names the user gave favorites (`worldmedia.favnames.v1`, since 0.1.12) and the stations kept on their own stream (`worldmedia.ownstream.v1`, since 0.1.12) | `worldmedia_runtime.py` |
| `state/song-log.json` | The song log, at most 500 songs | `worldmedia_songlog.py` |
| `state/starred-songs.json` | The starred songs, at most 2,000 (since 0.1.12) | `worldmedia_starred.py` |
| `station-images/` | The user's own station pictures | `worldmedia_station_images.py` |

The two settings added in 0.1.10, `tunerCardSize` and `soundMeter`, are fields
inside the existing settings value (`worldmedia.settings.v1`), not new profile
keys. Every release keeps settings fields it does not know, so going back to
0.1.9 and returning keeps them. The Visualizer's fields added in 0.1.11 (all
named `visualizer...`) are stored the same way, and so are the settings added
in 0.1.12: `bestStreamMode` (`off`, `listed` or `auto`), `processorUse`,
`processorLimit` and `visualizerQualityPicked`.

A favorite's own record keeps the station's original name;
`src/lib/favorite-names.js` lays the user's name over it when a list is shown
(at most 5,000 names of up to 80 characters), and `underOwnName()` in
`src/lib/other-streams.js` puts the original name back for directory lookups
and the Auto checks.

A profile save writes the main file first and then the extra file (or removes
it when nothing is left for it). If the second write fails, favorites and
settings are already current and only the categories are one step behind; the
page reports the failure and saves again. Both files are read and written under
one lock, so they always come from the same write. A page sends its own random
id and a number that goes up with every profile write (the headers
`X-WorldMedia-Profile-Writer` and `X-WorldMedia-Profile-Sequence`). A write
whose number is not higher than the last one taken for that page changes
nothing and is answered `{"saved": false, "superseded": true}`, so a save the
page gave up on cannot land after a later save or a clear. A write without the
headers (an older client) is applied as it always was.

- **Song log** (`worldmedia_songlog.py`): every write carries a revision, and a
  write that is not newer than the stored one is answered with what is stored
  instead of being applied. A file that cannot be understood is moved aside as
  `song-log-unreadable-<date>-<time>.json` (the newest three are kept) just
  before the first write that replaces it. **Save to file** writes
  `WorldMedia-song-log-<date>-<time>.csv` into `downloads` through a partial
  file. The server names the file; nothing in a request is a path.
- **Starred songs** (`worldmedia_starred.py`): the same rules as the song log
  (writes ordered by a revision, an unreadable file moved aside as
  `starred-songs-unreadable-<date>-<time>.json`, the newest three kept). Text
  with control, bidirectional or zero-width characters is refused. **Save as
  text** and **Save as CSV** write `WorldMedia-starred-songs-<date>-<time>.txt`
  or `.csv` into `downloads`. The file is separate from the song log, so
  **Clear log**, the log's limit and an older release's rewrite of
  `song-log.json` never touch it.
- **JSON and CSV playlists** (`worldmedia_playlist_tables.py`): a JSON or CSV
  list (at most 8 MiB and 50,000 entries) is turned into the same M3U text
  every other playlist is stored as, so `playlists.json` keeps its format and
  every entry goes through the same URL checks and **Add as** rules. The CSV
  separator (comma, semicolon or tab) is worked out from the first records.
- **Station images** (`worldmedia_station_images.py`): only ordinary files
  directly in the folder are listed; subfolders, links and junctions are not
  followed (at most 2,000 files of 2 MB). A picture is served only by an id
  from the last scan, after the folder and the file are checked again, and only
  when its bytes pass the same image check as remote artwork. Names are
  compared with `normalize_station_name`, the same rule as
  `src/lib/station-images.js` (shared cases are in
  `tests/fixtures/station-image-names.json`). A station whose name has a
  character a file name cannot have also matches a picture in which each such
  character is written as `-`, `_` or a space, or left out, and a reserved
  Windows name (`CON`, `AUX`, `COM1` and so on) matches a file with `_` or `-`
  after it. The Python side never sees station names, so this loose rule, and
  the choice of which picture goes to which station, are in
  `src/lib/station-images.js` only. The listing names each used file (`file`)
  and the files that were not used (`rejected`: at most 20, each with a reason
  and plain-words `text`; `rejected_more` counts the rest), which Settings shows
  as **Pictures to check**. The code only reads the folder, and makes it when
  the user asks to open it.
- **Backup** (`worldmedia_backup.py`): reads only a fixed list of files (the
  state files above, starred songs included, and the station pictures), never
  a path from a request. The favorites `.m3u8` files use the names the user
  gave favorites. The
  ZIP is written to a partial file in `downloads` and renamed when complete,
  holds at most 192 MB before compression, and only one backup runs at a time.
  The `.m3u8` exports are rebuilt from the saved favorites and playlists and
  hold only web addresses World Media can play.

## Important API surfaces (for diagnostics)

These are local implementation routes, not a public API contract:

| Route | Purpose |
|---|---|
| `GET /api/health`, `/api/ping` | Local liveness check |
| `GET /api/v1/session` | Obtain the current control-session token/origin |
| `GET /api/v1/runtime` | Runtime roots, writability, current/next port |
| `GET /api/v1/playlists` | Load locally saved channel lists |
| `POST /api/v1/playlists/import` | Parse and save a local M3U/M3U8, PLS, XSPF, JSON or CSV list (all but M3U are stored as M3U). The default type is `auto`, `tv` or `radio`; `auto` is saved as the type it chose |
| `POST /api/v1/playlists/link` | Save a direct link or safely fetch an online list (the same default types) |
| `POST /api/v1/playlists/remove` | Remove a list, keeping favorites |
| `GET` / `POST /api/v1/profile/preferences` | Bounded cross-port preference backup (two files; a write carries an order number) |
| `GET` / `POST /api/v1/song-log` | Load the song log, or save it (writes are ordered by a revision) |
| `POST /api/v1/song-log/export` | Write the song log as a CSV file in `downloads` |
| `GET` / `POST /api/v1/starred-songs` | Load the starred songs, or save them (writes are ordered by a revision) |
| `POST /api/v1/starred-songs/export` | Write the starred songs as a text or CSV file in `downloads` |
| `POST /api/v1/streams/probe` | A short look at a station's own stream and another directory entry for **Auto (verified)**; one pair at a time |
| `GET /api/v1/system/processor-use` | The app's share of the whole processor since the last reading (read only on request) |
| `GET /api/v1/station-images` | List the user's station pictures (scans the folder) |
| `GET /api/v1/station-images/{id}` | One station picture, by an id from the last listing |
| `POST /api/v1/station-images/open-folder` | Make and open the `station-images` folder |
| `POST /api/v1/station-images/save` | Save a picture for a station: the station's name and the picture as base64; checked like the folder scan, file name made from the name. First `{station, preview: true}` returns the full names of the files a new picture would replace, for the question; a save with `replace: true` carries exactly those names in `files`, and is refused if the folder holds others for the station by then. Without `replace` it never replaces a file (409, naming every file; names only, never a path). More than 20 such files are refused, so the user is never asked about only some of them. Only a file the folder lists under that very name is replaced, never another file's short (8.3) name or a link |
| `POST /api/v1/station-images/remove` | Delete the files of one station picture, by an id from the last listing: first `{id, preview: true}` returns the full file names for the question (more than 20 are refused), then `{id, files}` deletes only those that still make up that picture |
| `POST /api/v1/backup/create` | Write the backup ZIP into `downloads` |
| `GET /api/v1/jobs` | Capture job snapshots |
| `GET /api/v1/ffmpeg/status` | Toolchain status |
| `POST /api/v1/catalog/feed/resolve` | Native podcast feed resolution |
| `POST /api/v1/catalog/peertube/resolve` | Exact PeerTube origin resolution |
| `GET /api/v1/catalog/owncast/snapshot` | Verified Owncast live snapshot |
| `POST /api/v1/catalog/cache/clear` | Clear bounded catalog/artwork cache |
| `POST /api/v1/media/register` | Register an opaque playback/capture relay |
| `GET /api/v1/media/{id}` / `dash/{id}` | Stream/manifest relay |
| `GET /api/v1/media/{id}/now-playing` | Latest song title of a live audio playback relay |
| `POST /api/v1/jobs/download` / `record` | Start finite download/live recording |
| `POST /api/shutdown` | Authenticated terminal shutdown request |

Control routes reject query strings and unexpected fields. Never expose the
session token or use these routes as a network service.

The playlist store writes atomically beside the executable; invalid existing
data is not overwritten. Online imports use bounded, DNS-pinned public HTTP(S)
fetching, not an unrestricted localhost proxy. Imports are snapshots and have
separate file/storage safety limits; they do not cap the public catalog.

## Extension points

The source registry, adapter contract, scheduler policy, item model, capability
resolver, and capture state view are the intended extension seams. Keep user
visible behavior in the frontend and keep provider-specific parsing in its
adapter. New upstream URL handling belongs in the native semantic resolver,
not in a generic browser proxy.
