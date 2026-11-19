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
so a live empty snapshot cannot complete a VOD archive.

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

`src/lib/player.js` owns the single audio/video pair, ownership generations,
rapid-switch cancellation, relay lifetime, HLS/DASH cleanup, Web Audio EQ,
media-session controls, and the player bar. A failed media element is rebuilt on
Play rather than repeatedly poked after an error.

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
- **Drawing.** `scene-renderer.js` draws one scene at a time, as one shader pass
  on a WebGL canvas, with the uniforms Psychedelia's own renderer feeds.
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
- **Choosing.** `shuffle.js` picks scenes (a bag, a recent list, category and
  mood rules, the cost filter), `fx-shuffle.js` and `overlay-shuffle.js` pick
  effects and overlays within a cost budget per quality, and `favourites.js`
  stores a star as a short string: the scene, `:look`, `|effects` and `/overlays`.
- **Saved fields.** The choices are fields of the settings value
  (`worldmedia.settings.v1`), named `visualizer...` (see
  `src/lib/visualizer-settings.js`), not new profile keys or files. `Ctrl+Shift+D`
  shows a developer strip with the sound values the scenes get
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

If a server answers with something that is not HTTP, resets the connection, or
rejects the header with a client error (400, 406, 412, 415 or 431), the relay
repeats the request once without the header. A host where that repeat works is
not asked again for an hour. An old Shoutcast server that only answers
"ICY 200 OK" still cannot be played.

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
| `state/profile-preferences-extra.json` | Newer keys: the favorites categories (`worldmedia.favgroups.v1`) | `worldmedia_runtime.py` |
| `state/song-log.json` | The song log, at most 500 songs | `worldmedia_songlog.py` |
| `station-images/` | The user's own station pictures | `worldmedia_station_images.py` |

The two settings added in 0.1.10, `tunerCardSize` and `soundMeter`, are fields
inside the existing settings value (`worldmedia.settings.v1`), not new profile
keys. Every release keeps settings fields it does not know, so going back to
0.1.9 and returning keeps them. The Visualizer's fields added in 0.1.11 (all
named `visualizer...`) are stored the same way.

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
  state files above and the station pictures), never a path from a request. The
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
| `POST /api/v1/playlists/import` | Parse and save a local M3U/M3U8, PLS or XSPF list (PLS and XSPF are stored as M3U). The default type is `auto`, `tv` or `radio`; `auto` is saved as the type it chose |
| `POST /api/v1/playlists/link` | Save a direct link or safely fetch an online list (the same default types) |
| `POST /api/v1/playlists/remove` | Remove a list, keeping favorites |
| `GET` / `POST /api/v1/profile/preferences` | Bounded cross-port preference backup (two files; a write carries an order number) |
| `GET` / `POST /api/v1/song-log` | Load the song log, or save it (writes are ordered by a revision) |
| `POST /api/v1/song-log/export` | Write the song log as a CSV file in `downloads` |
| `GET /api/v1/station-images` | List the user's station pictures (scans the folder) |
| `GET /api/v1/station-images/{id}` | One station picture, by an id from the last listing |
| `POST /api/v1/station-images/open-folder` | Make and open the `station-images` folder |
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
