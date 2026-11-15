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
          ├─ Library / Tuner / Grid / Discovery / About
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
  `tests/fixtures/station-image-names.json`). The code only reads the folder,
  and makes it when the user asks to open it.
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
| `POST /api/v1/playlists/import` | Parse and save a local M3U/M3U8, PLS or XSPF list (PLS and XSPF are stored as M3U) |
| `POST /api/v1/playlists/link` | Save a direct link or safely fetch an online list |
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
