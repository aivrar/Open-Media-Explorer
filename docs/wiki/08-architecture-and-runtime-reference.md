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

- one global slot per registered source by default (up to eleven concurrent
  source lanes);
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

## Important API surfaces (for diagnostics)

These are local implementation routes, not a public API contract:

| Route | Purpose |
|---|---|
| `GET /api/health`, `/api/ping` | Local liveness check |
| `GET /api/v1/session` | Obtain the current control-session token/origin |
| `GET /api/v1/runtime` | Runtime roots, writability, current/next port |
| `GET /api/v1/jobs` | Capture job snapshots |
| `GET /api/v1/ffmpeg/status` | Toolchain status |
| `POST /api/v1/catalog/feed/resolve` | Native podcast feed resolution |
| `POST /api/v1/catalog/peertube/resolve` | Exact PeerTube origin resolution |
| `GET /api/v1/catalog/owncast/snapshot` | Verified Owncast live snapshot |
| `POST /api/v1/catalog/cache/clear` | Clear bounded catalog/artwork cache |
| `POST /api/v1/media/register` | Register an opaque playback/capture relay |
| `GET /api/v1/media/{id}` / `dash/{id}` | Stream/manifest relay |
| `POST /api/v1/jobs/download` / `record` | Start finite download/live recording |
| `POST /api/shutdown` | Authenticated terminal shutdown request |

Control routes reject query strings and unexpected fields. Never expose the
session token or use these routes as a network service.

## Extension points

The source registry, adapter contract, scheduler policy, item model, capability
resolver, and capture state view are the intended extension seams. Keep user
visible behavior in the frontend and keep provider-specific parsing in its
adapter. New upstream URL handling belongs in the native semantic resolver,
not in a generic browser proxy.
