# Five New Audio/Video Sources - Research and Architecture Dossier

Status: implementation and release-evidence Phases 0-11 complete on 2026-07-15
Research date: 2026-07-14
Target application: Open Media Explorer 0.1.2 working tree
Companion execution plan: [FIVE_NEW_SOURCES_PHASES.md](FIVE_NEW_SOURCES_PHASES.md)

## Purpose

This document records the codebase audit, official-source research, live API
observations, architecture decisions, risks, and acceptance requirements for
adding these five no-key sources:

1. media.ccc.de / C3VOC
2. Library of Congress
3. gPodder.net plus podcast RSS/Atom feeds
4. PeerTube through the SepiaSearch public index
5. Owncast Directory

The goal is not merely to make five names appear in the sidebar. Each source
must participate correctly in browse, search, pagination, retries, thumbnails,
favorites, playback, download/record capability, EQ, settings, accessibility,
packaging, and shutdown without weakening the app's existing security model.

This is a planning artifact. It does not contain production implementation.
Implementation is gated by the companion phase plan.

## Scope and non-goals

In scope:

- Public audio and video only; still-image archives are not in scope.
- Catalog discovery without user API keys or accounts.
- On-demand playback and direct download when the provider explicitly exposes
  a downloadable media file.
- Live playback and recording through the existing safe media relay and FFmpeg
  job system.
- Correct source-specific rights labels and capability suppression.
- A user-controlled explicit-content preference. Content explicitly marked
  NSFW/explicit is hidden by default and appears only after the user manually
  enables it in Settings.
- Safe handling of federated and user-controlled origins.
- Resilient pagination, rate limiting, caching, and transient-error recovery.
- Desktop and single-EXE integration on Windows.

Out of scope for this addition:

- User login, subscription synchronization, comments, likes, uploads, or chat.
- User-entered arbitrary PeerTube instances, RSS URLs, or OPML imports. The
  internal feed normalizer will be designed so a later feature can add these
  safely, but no UI for them is part of this task.
- Downloading slides, PDFs, captions, or images as primary library items.
- Torrent/WebTorrent/IPFS playback.
- Circumventing access restrictions, DRM, geoblocking, or provider policy.
- Fuzzy cross-provider deduplication based only on titles.

## Executive decisions

- The five sources use public endpoints and require no stored API key. That
  does not mean every item is public domain or downloadable.
- Five stand-alone frontend adapters are insufficient. The app also needs a
  fair catalog scheduler, dynamic-snapshot support, a narrow authenticated
  catalog gateway, and an opaque image relay.
- The existing generic metadata proxy remains fixed-host and HTTPS-only. It
  must never receive wildcard PeerTube, podcast, or Owncast origin access.
- Arbitrary RSS/Atom feeds are fetched only by a dedicated backend normalizer
  through `SafeConnector`. Raw XML is never returned to the WebView.
- Python's documentation warns that the standard XML modules are unsafe for
  malicious XML and recommends `defusedxml`. Pin `defusedxml==0.7.1`, enable
  DTD/entity/external-reference rejection, and retain independent byte/tree
  limits. See [Python XML security](https://docs.python.org/3.12/library/xml.html)
  and [defusedxml on PyPI](https://pypi.org/project/defusedxml/).
- PeerTube catalog search uses the official SepiaSearch service. Video detail
  resolution is performed against the video's canonical origin by a dedicated
  backend resolver; it is not a generic arbitrary-JSON proxy.
- Owncast uses the documented IPTV playlist for live stream URLs, but the
  playlist is not safe by itself because it omits the directory's NSFW
  boolean. A normalized snapshot must cross-check the playlist with the
  directory site's current JSON, retain the verified rating, and fail closed
  if that metadata is missing or malformed.
- Add a persisted `showExplicitContent` setting that defaults to `false` on
  fresh installs and every migration. It can become `true` only through an
  explicit user action in Settings. When enabled, entries positively marked
  explicit may appear with a visible rating label; it never relaxes URL,
  schema, SSRF, privacy, or playback validation.
- Library of Congress traffic is limited to the stricter general guideline of
  10 requests per minute, even though the JSON API page lists 20 per minute.
- Only validated authoritative pagination can mark a finite catalog exhausted.
  HTTP errors, timeouts, rate limits, CAPTCHA HTML, malformed data, and
  suspicious empty responses remain retryable.
- Live directories are snapshots, not permanently exhausted catalogs. The
  orchestration contract must refresh and atomically reconcile them.
- New dynamic thumbnail URLs never load directly in `<img>`. They are fetched
  through an opaque, MIME-checked, SSRF-safe local asset relay.
- Saved favorites never persist expiring local media or asset tokens. They keep
  canonical origin metadata and obtain new opaque tokens each app session.
- Registry entries stay disabled from production registration until all five
  adapters and shared infrastructure have passed their isolated phases. This
  prevents an incomplete source from appearing in release builds.
- The word "10/10" is an evidence standard, not a subjective declaration. All
  ten final quality dimensions in the phase plan must pass; one failed gate
  means the addition is not complete.

Policy clarification from the owner: explicit content and federated hosting
are not reasons to reject a source. Explicit content is a deliberate user
choice through the default-off setting. Dynamic-host validation remains a
transparent technical safeguard. The provider problems that should surface as
reliability states are dead links, malformed responses, throttling, and
temporary connection failures.

## Why the five sources are distinct

| Source | Unique role | Main media | Catalog style |
|---|---|---|---|
| media.ccc.de / C3VOC | Technical and community conference recordings plus event live streams | Video, audio, live HLS | Finite paged archive plus live snapshot |
| Library of Congress | US cultural heritage audio and film/video | Audio and video | Heterogeneous paged archive with lazy item resources |
| gPodder.net | Open podcast directory that leads to publisher feeds | Podcast audio/video and occasional live items | Directory-to-feed fan-out |
| PeerTube / SepiaSearch | Federated independent video hosting | VOD and live HLS | Global index plus dynamic origin resolution |
| Owncast Directory | Independent self-hosted live broadcasters | Live HLS video | Rapidly changing directory snapshot |

Exact URL deduplication will be performed where possible. Semantic overlap can
still exist - for example, a CCC talk may be mirrored on PeerTube - but title
matching is too error-prone to merge those records automatically.

## Current codebase audit

### Source and item contracts

- `src/lib/sources.js` is the source registry and lazy adapter loader. It
  currently defines six sources.
- Every adapter must return the strict model from `src/lib/item-model.js`:
  `id`, title/description, source, type, stream URL/kind, delivery,
  download fields, capture headers, thumbnail, metadata, license, source URL,
  normalized content rating, and optional `_extra` resolver data.
- `src/lib/media-capabilities.js` correctly derives Download, Record audio,
  Record video, Checking, or Unavailable from item capability fields rather
  than source IDs. New adapters must preserve that boundary.
- `src/lib/player.js` resolves lazy items, registers remote media through the
  same-origin relay, and then attaches direct/HLS/DASH playback. New sources
  must use this path rather than bypassing it.
- Download and recording already use opaque media registrations and the FFmpeg
  job system. Live and finite classifications must be accurate before those
  buttons can be trusted.
- The current `iptv-org` adapter drops `is_nsfw:true` channels while loading.
  The new preference must preserve that default but retain the upstream rating
  so those channels can be included only after the user opts in.

Proposed source IDs and types:

| ID | Display name | Types |
|---|---|---|
| `media-ccc` | media.ccc.de | `video`, `audio`, `tv`, `radio` |
| `library-of-congress` | Library of Congress | `video`, `audio` |
| `gpodder` | gPodder Podcasts | `audio`, `video`, `radio`, `tv` |
| `peertube` | PeerTube | `video`, `tv` |
| `owncast` | Owncast | `tv` |

`radio` and `tv` are reserved for genuinely live audio/video items. Finite
podcast episodes remain `audio` or `video`.

### Discovery and pagination

- `src/lib/search.js` and `src/modes/library/chain.js` own search fan-out and
  cursor-based browsing.
- A source is retired only when an adapter explicitly returns
  `exhausted: true`. Existing retry state in
  `src/modes/library/progress.js` correctly preserves a cursor on failure.
- Initial browse and each subsequent chain currently invoke every enabled
  source in parallel. Eleven sources, plus gPodder feed fan-out, would turn
  startup into an uncontrolled request burst.
- Search also fans out to all enabled sources concurrently.
- `view.items` grows without a resident-memory bound. Only DOM rendering is
  capped (300 initially, then 200 at a time). PeerTube currently indexes more
  than 800,000 videos, so continuous automatic ingestion is not viable.
- The existing result contract cannot distinguish a finite archive end from a
  completed live snapshot that must refresh later.

Required orchestration changes:

1. At most four source catalog operations run at once, selected fairly rather
   than in source-registry order.
2. Search uses the same pool and retains partial-result rendering and aborts.
3. Source-specific token buckets handle stricter upstream limits.
4. A bounded prefetch reservoir pauses once the user has ample unseen cards;
   scrolling or an explicit retry resumes it. The UI must say "more available"
   rather than falsely saying "complete."
5. A hard resident-item ceiling evicts only nonfavorite, noncurrent,
   non-detail items from the oldest unseen pages. Search remains the route to
   deep catalogs.
6. A separate snapshot lane periodically reconciles live directory items
   without resetting the finite VOD cursor.

### Settings, modes, and UI

- `normalizeSettings()` starts from all current source IDs enabled and overlays
  saved booleans. Therefore the five new sources can default on without
  deleting existing per-source choices.
- Settings source switches are generated from `SOURCES`, but their explanatory
  source list is hard-coded.
- Library sidebar source rows are generated dynamically, while About has a
  separate hard-coded source information table and color map.
- Discovery, Grid, Tuner, sidebar counts, source filters, and status pills all
  enumerate sources and need 11-source verification.
- The production UI harness and baseline UI fixture explicitly expect the six
  current adapters.
- Eleven sidebar rows do not fit all supported window heights unless the source
  list scrolls independently and keeps keyboard focus visible.
- Eleven source-status pills need wrapping or horizontal scrolling without
  clipping search/filter controls.
- Settings currently has no content-rating preference. Add
  `showExplicitContent:false` with an explanatory, accessible toggle. Saved
  settings that predate the field must always migrate to `false`; source or
  theme migration must never turn it on implicitly.

The registry should become the single source of truth for display name, types,
color, homepage, short description, rights note, and adapter loader. About and
Settings should render that metadata instead of maintaining duplicate lists.

### Network and security boundaries

- `worldmedia_server.py` has a fixed metadata-proxy host allowlist, a 20-second
  upstream timeout, a 50 MiB cap, and a local 60 requests/second ceiling.
- `worldmedia_media.py` provides `SafeConnector`: it rejects credentials and
  malformed hosts, resolves and pins globally routable IPs, revalidates every
  redirect, rejects private/local/link-local destinations, and verifies TLS
  against the original hostname.
- Continuous media uses the separate opaque media relay and must continue to
  do so.
- Provider artwork is validated and relayed through the same-origin asset
  service before any `<img>` receives it. Direct-link protocol rewriting is
  deliberately absent, so HTTP-only artwork is handled by the relay policy
  rather than silently rewritten in the browser.

### Persistence

- Favorites and settings are persisted in WebView2 localStorage under the
  existing versioned keys.
- A favorite stores item data. Any local `/api/v1/media/...` or
  `/api/v1/assets/...` URL is a per-launch capability and will be invalid after
  restart.
- New favorite normalization must clear expired opaque URLs, retain canonical
  resolver/artwork metadata, validate the source ID, and mark the item for
  re-resolution without deleting the favorite.
- New source IDs must be stable before release. IDs are part of favorites and
  favorite-specific EQ keys.

## Shared architecture

### 1. Catalog operation scheduler

Add a pure/testable scheduler (proposed `src/lib/catalog-scheduler.js`) with:

- global maximum of four active source operations;
- round-robin fairness across enabled sources;
- separate high-priority user actions and low-priority prefetch work;
- per-source cancellation using `AbortSignal`;
- no scheduling for disabled sources;
- provider cooldown and `Retry-After` support;
- bounded queue length and deduplication of identical in-flight work;
- deterministic fake-clock tests;
- visibility-aware prefetch so minimized/hidden windows do not keep crawling.

Initial provider policies are conservative defaults, not upstream promises:

| Provider | Policy |
|---|---|
| Library of Congress | One request every 6 seconds, burst 1, shared by browse/search/resolve |
| media.ccc.de | At most 2 concurrent, target no more than 2 requests/second |
| gPodder directory | At most 1 request/second, burst 2 |
| Podcast feeds | Global 4 concurrent, per-host 1 concurrent |
| SepiaSearch | At most 2 concurrent, target 2 requests/second |
| PeerTube origins | Global 4 concurrent, per-host 2 concurrent; honor origin rate headers |
| Owncast directory | One normalized refresh every 2 minutes unless user requests retry |

The scheduler must not sleep on the UI thread. It schedules promises/timers and
remains abortable.

### 2. Strict HTTP helpers

Extend `src/lib/http.js` with explicit `getJson`, `getText`, and `postJson`
operations rather than returning either parsed JSON or arbitrary text from the
same call. Requirements:

- preserve current timeout and abort behavior;
- carry status, response content type, and parsed `Retry-After` in `HttpError`;
- enforce caller-provided response byte budgets;
- reject HTML when JSON is required;
- retry only transient transport, 408, 429, and 5xx failures;
- never retry an explicit user abort;
- accept GraphQL errors as a typed provider error even when HTTP is 200;
- never interpret malformed or CAPTCHA HTML as an empty successful page.

### 3. Secure catalog gateway

Add a small backend module (proposed `worldmedia_catalog.py`) and narrow,
authenticated same-origin routes. Reuse `controlRequest()` and the existing
session token/origin validation.

Proposed routes:

```text
POST /api/v1/catalog/feed/resolve
POST /api/v1/catalog/peertube/resolve
GET  /api/v1/catalog/owncast/snapshot
```

The routes accept semantic identifiers, not arbitrary proxy instructions:

- Feed resolve accepts one HTTP(S) feed URL and returns normalized feed and
  episode JSON only.
- PeerTube resolve accepts a canonical public watch URL plus UUID, constructs
  the exact origin API path, and returns normalized public video details only.
- Owncast snapshot accepts no upstream URL; the backend knows the two fixed
  official directory endpoints and returns a rating-verified live snapshot.

All dynamic outbound requests use `SafeConnector`. No route returns raw XML,
raw arbitrary JSON, cookies, upstream headers, filesystem data, or an
attacker-selected local path.

### 4. Defended podcast feed parser

The feed resolver must:

- allow only HTTP and HTTPS with no credentials;
- reject private/non-global DNS answers and revalidate redirects;
- cap redirects, connect/read time, compressed bytes, decoded bytes, and final
  XML at each boundary;
- use `defusedxml.ElementTree` with DTD, entities, and external references
  forbidden;
- independently cap tree depth, elements, attributes, text, namespace length,
  and emitted episodes;
- support RSS 2.0 enclosures and Atom 1.0 `rel="enclosure"`;
- optionally support Podcasting 2.0 `alternateEnclosure`, `liveItem`, and
  `license` only through the documented semantics;
- use the normal enclosure as compatibility fallback;
- emit a live item only when `status="live"`; pending and ended entries are not
  currently playable live media;
- reject non-HTTP transports and unsupported MIME types;
- strip HTML to bounded plain text rather than forwarding markup;
- carry ETag/Last-Modified and use conditional refreshes;
- cache redirect aliases and the last-known-good normalized feed;
- isolate a dead/malformed feed so it cannot fail the entire gPodder source.

### 5. Opaque asset relay

Add authenticated registration and unguessable read routes, analogous to the
media relay:

```text
POST /api/v1/assets/register
GET  /api/v1/assets/{opaque-id}
POST /api/v1/assets/{opaque-id}/expire
```

Registration accepts one validated image URL and source/item scope. Fetching
uses `SafeConnector` and must:

- accept only JPEG, PNG, GIF, and WebP after both MIME and magic-byte checks;
- reject SVG, HTML, XML, scripts, polyglots that fail the selected decoder
  signature, and MIME mismatches;
- cap bytes, dimensions, and decoded pixel area;
- strip upstream cookies and active headers;
- cache by canonical URL with bounded TTL/LRU and request coalescing;
- expose only a local opaque URL to `<img>`;
- support cancellation when cards leave the hydration window;
- never persist opaque IDs in favorites.

Dynamic artwork from gPodder feeds, PeerTube origins, Owncast servers, and LOC
resource hosts must use this relay. The later hardening phase should migrate
the old sources too so all artwork shares one security boundary.

### 6. Finite pages and dynamic snapshots

Keep the existing finite page shape and add an optional independent snapshot
contract:

```text
browsePage(opts) -> { items, cursor, exhausted }
refreshSnapshot(opts) -> { items, snapshotId, refreshAfterMs }
```

`refreshSnapshot` is optional. The Library orchestrator stores snapshot items
separately from accumulated archive pages and atomically replaces the previous
snapshot for that source. It must:

- update changed items rather than ignoring duplicate IDs;
- remove an offline item from the live snapshot without deleting its saved
  favorite or interrupting current playback;
- never count a snapshot refresh as finite-catalog exhaustion;
- retain the last-known-good snapshot and mark it stale on transient failure;
- schedule the next refresh through the same fair catalog scheduler;
- stop refreshing disabled sources or a closing app;
- expose "live snapshot", "stale", and "retrying" honestly in status UI.

media.ccc.de uses both finite VOD pages and a C3VOC live snapshot. Owncast is a
snapshot-only source. Other adapters may adopt the contract later.

### 7. Cache and memory policy

Use a bounded public-metadata cache under the existing runtime state/cache root,
not beside the EXE and not in PyInstaller `_MEIPASS`.

Required behavior:

- versioned cache records with provider, canonical key, fetched/expiry time,
  ETag/Last-Modified, schema version, and normalized payload;
- atomic writes and corruption-tolerant reads;
- per-entry and total byte ceilings with LRU eviction;
- no authentication secrets, cookies, local addresses, opaque relay tokens, or
  raw unbounded feeds;
- Settings "clear cache" removes this catalog/asset cache but not downloads,
  favorites, EQ data, or managed FFmpeg unless the existing confirmation says
  otherwise;
- stale cache can keep a source useful during a transient outage but must be
  labeled stale and refreshed in the background;
- an unfiltered catalog returning a suspicious zero must not overwrite a
  nonempty last-known-good cache after one attempt.

The in-memory item pool must have a documented ceiling. Eviction never removes
favorites, the current player item, the open details item, or visible cards.
The exact ceiling is selected from Phase 0 measurements and verified under the
eleven-source performance phase rather than guessed here.

### 8. Stable identity and favorite rehydration

| Source | Stable identity |
|---|---|
| media.ccc.de | Event GUID; live room uses conference/room/native-language key |
| Library of Congress | Canonical `/item/{id}/` identifier |
| gPodder | SHA-256 of normalized directory feed identity plus episode GUID; enclosure URL fallback |
| PeerTube | Normalized origin host plus video UUID |
| Owncast | SHA-256 of normalized instance base URL |

Exact canonical URL hashes are deterministic and never include session tokens.
All `_extra` resolver data is length/type validated when loaded from storage.

On favorite load:

1. Validate the source still exists.
2. Remove local opaque media/asset URLs.
3. Preserve canonical source, feed, artwork, and watch identifiers.
4. Mark stream/artwork resolution pending where necessary.
5. Let the adapter obtain fresh metadata and local opaque registrations.
6. Preserve the favorite-specific EQ key because the public item ID is stable.

### 9. Rights, availability, and capability rules

"Publicly reachable" is different from "public domain." The card and details
panel must not invent a license.

| Source/item | Playback | Download/record action | License label |
|---|---|---|---|
| media.ccc.de VOD | Direct supported recording | Download selected official recording | Explicit API metadata if present; otherwise "See event license" |
| C3VOC live | HLS/native live stream | Record audio/video | "See event/source" |
| LOC item | Public stream/file only | Download only when resource/file flags allow and no access/download restriction is set | Concise rights field or "See LOC rights" |
| Podcast episode | HTTP(S) standard enclosure | Download enclosure offered by publisher | Podcasting 2.0 license if present; otherwise "See publisher" |
| Podcast live item | Supported live enclosure while status is live | Record audio/video | Feed/episode license or "See publisher" |
| PeerTube VOD | Public, published HLS/MP4 permitted by the content preference | Download only when `downloadEnabled` and a concrete public download file exist | Provider license label, including All Rights Reserved when applicable |
| PeerTube live | Public published HLS | Record video | Provider license label |
| Owncast | Rating-verified online HLS permitted by the content preference | Record video; no finite download | "Independent broadcaster - see source" |

The app's existing user-responsibility notice remains, but it is not a reason
to expose a button contrary to an explicit provider restriction.

## Provider research and mapping

### media.ccc.de / C3VOC

Official evidence:

- [C3VOC API index](https://c3voc.de/wiki/api)
- [Voctoweb public GraphQL and JSON API documentation](https://github.com/voc/voctoweb#apis)
- [C3VOC streaming JSON API](https://github.com/voc/streaming-website#json-api)
- [media.ccc.de download and license information](https://media.ccc.de/about.html)

Public endpoints:

```text
GET  https://api.media.ccc.de/public/events/recent?page=N
GET  https://api.media.ccc.de/public/events/{guid}
POST https://media.ccc.de/graphql
GET  https://streaming.media.ccc.de/streams/v2.json
```

The public REST event/recording endpoints use RFC 5988 `Link` pagination. The
GraphQL endpoint lets a client request lecture resources in one response.
Downloads are explicitly encouraged, but the site says the license encoded in
the actual recording applies; if no license is encoded, users should consult
the organizers.

Live observations on 2026-07-14 (evidence, not hard-coded assumptions):

- `/public/events/recent` returned 100 correctly recent event summaries and
  `next`/`last` Link relations; the last page was 168 at observation time.
- An event summary included GUID, title, release date, language, people, tags,
  thumbnail/poster URLs, canonical page, and detail API URL, but not recording
  files.
- Event detail included MP4, WebM, MP3, and Opus recordings with MIME, language,
  dimensions, quality flag, size, and direct URL.
- GraphQL `lectureSearch(query:, page:)` returned 25 lectures per page with
  stable GUIDs and complete preferred video/audio resources.
- The documented REST `/public/events/search?q=...` returned HTTP 500 for
  ordinary terms. GraphQL search worked and is therefore the selected search
  path.
- GraphQL `lectures(orderBy: date_DESC)` surfaced old records with null dates
  before newer releases. It is not the selected browse path.
- `streams/v2.json` returned a valid empty array because no event was live.
  Empty live data must not suppress the VOD archive.

Adapter design:

- Browse VOD through `/events/recent` and RFC Link pagination. Cache each
  100-event upstream page and emit app pages of 30 without refetching it.
- Lazy-resolve an event detail only on play/download/details that need files.
- Search through a fixed GraphQL query; reject a response containing GraphQL
  errors or missing lecture schema.
- Select one card per lecture. Prefer compatible native-language MP4 video;
  use MP3 audio when no compatible video exists. Do not create duplicate cards
  for every encoding.
- Use official direct recording URL for both finite playback and download.
- Strip bounded HTML descriptions to plain text.
- Implement C3VOC live as `refreshSnapshot`; prefer native HLS video, then a
  lower compatible native HLS variant, and represent audio-only rooms as live
  radio. Avoid duplicate translated/slides streams unless they are the only
  usable rendition.
- Treat a valid empty live array as an empty snapshot with a refresh time, not
  an error and not VOD exhaustion.
- Capture a nonempty official v2 fixture during an event before final release;
  the published API is append-only but its formal schema is intentionally
  light.

### Library of Congress

Official evidence:

- [JSON/YAML API overview](https://www.loc.gov/apis/json-and-yaml/)
- [API endpoints](https://www.loc.gov/apis/json-and-yaml/requests/endpoints/)
- [Item and resource responses](https://www.loc.gov/apis/json-and-yaml/responses/item-and-resource/)
- [Working within limits](https://www.loc.gov/apis/json-and-yaml/working-within-limits/)
- [Streaming Services](https://www.loc.gov/apis/micro-services/streaming-services/)
- [Library of Congress legal/use guidance](https://www.loc.gov/legal/)

Public endpoints:

```text
GET https://www.loc.gov/audio/?fo=json&at=results,pagination&c=30&sp=N
GET https://www.loc.gov/film-and-videos/?fo=json&at=results,pagination&c=30&sp=N
GET https://www.loc.gov/item/{id}/?fo=json&at=item,resources
```

The API requires no key. Its data is explicitly heterogeneous. Resource
objects may expose `audio`, `video_stream`, nested `files`, derivatives,
streams, `download_restricted`, `canDownload`, `rights_restricted`, access
advisories, and other collection-specific shapes.

Rate and reliability facts:

- The JSON/YAML page lists 20 requests/minute and a one-hour block after
  exceeding it.
- It warns that 429 responses or CAPTCHA HTML can occur below that rate during
  load.
- The general legal guidance recommends no more than 10 requests/minute to
  Library applications. The app will use this stricter total.
- Paging beyond 100,000 items in one query is unsupported.
- During this research, initial audio/video JSON calls succeeded and a later
  call received CAPTCHA HTML. That is a normal retry/cooldown condition, not a
  zero-result completion.

Adapter design:

- Alternate audio and film/video lanes in the cursor so one upstream request
  produces each page and neither lane starves.
- Use summary data for cards and lazy item-resource resolution for media.
- Share one 10/minute token bucket across browse, search, and resolve.
- Validate JSON content type and required result/pagination fields before
  accepting a page.
- Honor `Retry-After`; on 429/CAPTCHA, enter a long provider cooldown and keep
  the cursor unchanged.
- Normalize `http://www.loc.gov` identifiers to canonical HTTPS.
- Select a public supported stream for playback. Expose a download only when
  item/resource/file access and download flags all permit it.
- Never label the entire source Public Domain. Preserve a concise rights note
  and link to the canonical LOC item.
- Cache successful summaries/details so scrolling and favorite rehydration do
  not consume the rate budget repeatedly.
- Stop before the documented deep-paging limit and expose a truthful
  search/refine message rather than attempting unsupported pages.

### gPodder.net and publisher feeds

Official evidence:

- [gPodder podcast directory recommendation](https://gpodder.github.io/docs/podcast-directories.html)
- [gpodder.net API documentation PDF](https://app.readthedocs.org/projects/gpoddernet/downloads/pdf/latest/)
- [RSS 2.0 enclosure and GUID specification](https://www.rssboard.org/rss-specification)
- [Atom 1.0 enclosure relation](https://datatracker.ietf.org/doc/html/rfc4287)
- [Podcasting 2.0 alternate enclosure](https://podcasting2.org/docs/podcast-namespace/tags/alternate-enclosure)
- [Podcasting 2.0 live item](https://podcasting2.org/docs/podcast-namespace/tags/live-item)
- [Podcasting 2.0 license](https://podcasting2.org/docs/podcast-namespace/tags/license)
- [gPodder feed-service public-instance condition](https://gpoddernet-feed-service.readthedocs.io/en/latest/instances.html)

Public no-auth endpoints:

```text
GET https://gpodder.net/toplist/{1..100}.json
GET https://gpodder.net/search.json?q={query}
```

gPodder returns podcast feed URLs and show metadata; it does not return episode
media. The app must then fetch and normalize each publisher's feed. The separate
`feeds.gpodder.net` parsing service is not selected because its operator asks
application developers to contact them before use.

Live observations on 2026-07-14:

- Search and toplist calls returned 20 podcast records with URL, title, author,
  description, subscribers, logo URLs, website, and gPodder link.
- Many directory feed URLs were still HTTP even when the publisher redirected
  to HTTPS.
- In a bounded sample of 20 science feeds, 16 returned valid XML with an
  enclosure within the response budget; 13 redirected from HTTP to HTTPS.
  Other feeds produced 404, 502, timeout, or connection failures.
- Therefore dead/stale feeds are ordinary and must be isolated per feed.

Adapter design:

- Browse the toplist snapshot (maximum 100 shows) and interleave a bounded
  number of recent episodes per feed so one show cannot dominate a page.
- Fetch at most four feeds concurrently and at most one per origin host.
- Return a short page with `exhausted: false` when a feed batch yields fewer
  than 30 usable episodes; a short page is not proof that remaining feeds are
  exhausted.
- Search gPodder for candidate shows, then normalize a bounded feed subset and
  return episodes whose episode/show metadata matches the query.
- Support finite RSS/Atom enclosures as on-demand download/play items.
- Support Podcasting 2.0 live items only while status is `live` and a compatible
  HTTP(S) enclosure is present.
- Normalize feed/episode adult/explicit markers. Hide marked episodes while
  `showExplicitContent` is false and include them, visibly labeled, only while
  it is true. Feeds without an explicit marker remain `unrated`, not
  automatically explicit.
- Prefer the standard/default MP3 or H.264 MP4 enclosure. Support HLS when MIME
  or URL clearly identifies it. Ignore IPFS/WebTorrent and unsupported codecs.
- Use Podcasting 2.0 license when present; otherwise say "See publisher."
- Publisher enclosure URLs are intentionally distributable podcast files, so
  finite episodes can expose Download even when reuse rights are unspecified.
- Artwork always uses the opaque asset relay.

### PeerTube through SepiaSearch

Official evidence:

- [PeerTube REST API reference](https://docs.joinpeertube.org/api-rest-reference)
- [PeerTube search behavior](https://docs.joinpeertube.org/use/search)
- [Official SepiaSearch browse page](https://joinpeertube.org/browse-content)
- [PeerTube/Framasoft FAQ](https://joinpeertube.org/en_US/faq)

Public endpoints:

```text
GET https://sepiasearch.org/api/v1/search/videos
GET https://{origin-host}/api/v1/videos/{uuid}
GET https://{origin-host}/api/v1/videos/licences
```

PeerTube instances expose public catalog/detail endpoints without auth. A
single instance knows only local/followed content unless global index search is
enabled. Framasoft hosts and promotes SepiaSearch as its one global PeerTube
search index, so that fixed service is the selected catalog.

PeerTube's documented default API rate is 50 calls per 10 seconds per instance,
announced with 429 and `X-RateLimit-*`/`Retry-After` headers. Administrators can
customize it, so origin headers override local defaults.

Live observations on 2026-07-14:

- SepiaSearch accepted browse without a search term using `start`, `count`,
  `sort=-publishedAt`, and `nsfw=false`.
- The unfiltered index reported 826,607 results at observation time; a
  technology query reported 8,857. These totals are volatile.
- Results supplied UUID, canonical watch URL, title, dates, duration, tags,
  thumbnail/preview URLs, `isLive`, NSFW fields, public privacy, account,
  channel, language, and license.
- A public live origin detail returned a master HLS playlist and
  `downloadEnabled:false`.
- A public VOD detail returned a master HLS playlist, multiple resolution
  files, `downloadEnabled:true`, and explicit license.
- License endpoint values 1-8 cover Creative Commons/Public Domain/free-known-
  restriction variants; value 9 is All Rights Reserved.

Adapter design:

- Browse SepiaSearch by `start`/`count`, recent-first, and no scheduled-live
  inclusion. While `showExplicitContent` is false, request `nsfw=false` and
  independently filter explicit results; when it is true, omit that exclusion
  and retain the provider's explicit/flag state for visible labeling.
- Reject any result whose privacy is not Public, canonical watch URL is
  invalid, content-rating fields are malformed, or required schema is absent.
  A valid positive NSFW marker is a filterable rating, not malformed data.
- Lazy-resolve the canonical origin detail through the dedicated backend route.
- The resolver constructs `/api/v1/videos/{uuid}` on the exact normalized
  watch origin, disallows cross-origin API redirects, applies `SafeConnector`,
  and validates public/published state and content rating again. Explicit media
  may resolve only when the request reflects the enabled user preference.
- Prefer HLS master playback; fall back to a compatible public Web Video MP4.
- `isLive:true` becomes live TV/record. VOD becomes on-demand video.
- Expose VOD Download only when `downloadEnabled:true` and a concrete public
  file/download URL exists. License and download permission remain separately
  displayed.
- Use origin host plus UUID as identity, not Sepia's internal numeric ID.
- Fetch thumbnails only through the asset relay.
- Treat SepiaSearch's current public API as schema-guarded operational
  behavior: fixtures and an opt-in live probe detect drift, and drift produces
  retry/stale UI rather than malformed cards.

### Owncast Directory

Official evidence:

- [Owncast Directory behavior](https://owncast.online/docs/directory/)
- [Documented directory IPTV playlist](https://owncast.online/docs/watching-on-tvs/)
- [Owncast HLS playback](https://owncast.online/docs/video/)
- [Owncast API documentation](https://owncast.online/api/latest/)

Public endpoints used by the normalized snapshot:

```text
GET https://directory.owncast.online/api/iptv
GET https://owncast.directory/api/home
```

The IPTV endpoint is the documented public directory feed. The `/api/home`
shape is used by the current official directory web application but is not a
documented stable integration API. It is therefore a safety cross-check behind
strict schema guards and last-known-good caching, not an unquestioned contract.

Live observations on 2026-07-14:

- The M3U snapshot changed while researching, as expected for a live directory.
  The final probe found 60 stream URLs.
- Entries used `tvg-ID`, `tvg-logo`, and `tvg-tags`; tags contain commas inside
  quotes, and at least one title/attribute contained embedded newlines. A naive
  split on comma or line is incorrect.
- `/api/home` returned online/offline sections, featured entries, and explicit
  `nsfw` booleans.
- All 60 M3U stream origins matched the online JSON set at the final probe, and
  10 of those matched entries were explicitly NSFW in JSON even though the M3U
  text contained no `nsfw` marker.
- Consequently, using the M3U alone cannot enforce the default-off preference
  or accurately label entries when the user opts in.

Adapter/gateway design:

- The backend fetches both official-directory responses and parses the M3U with
  a bounded state machine, not delimiter splitting.
- Normalize BOM/CRLF, quoted attributes, commas, multiline fields, case, field
  length, entry count, URI schemes, and duplicate URLs.
- Match M3U stream origins to online JSON instances. Normalize only entries in
  both data sets whose `nsfw` value is an exact boolean, preserving true/false
  as their verified content rating.
- If JSON rating metadata fails or drifts, retain a stale last-known-good
  verified snapshot and retry. Never fall back to the unrated M3U.
- With `showExplicitContent:false`, expose only verified `nsfw:false` entries.
  With the setting explicitly enabled, verified `nsfw:true` entries may also
  appear and must carry a visible NSFW label.
- Use the exact playlist URI supplied by the directory; do not reconstruct it
  unless a future documented contract requires that.
- Emit live TV/HLS, no finite download, and the existing Record video action.
- Use the normalized instance homepage as `source_url` and identity basis.
- Fetch logos only through the asset relay.
- Refresh approximately every two minutes, with user retry available. A valid
  empty rating-joined snapshot is allowed but is never permanent exhaustion.

## Fixed-host metadata proxy policy

Add only exact catalog hosts (plus a canonical equivalent only when observed
and tested):

| Host | Purpose |
|---|---|
| `api.media.ccc.de` | REST archive metadata |
| `media.ccc.de` | GraphQL search |
| `streaming.media.ccc.de` | Live snapshot |
| `www.loc.gov`, `loc.gov` | LOC catalog/item metadata |
| `gpodder.net`, `www.gpodder.net` | Podcast directory |
| `sepiasearch.org` | PeerTube global index |
| `directory.owncast.online` | Documented IPTV directory |
| `owncast.directory` | Directory online/content-rating metadata |

Do not add wildcard suffixes for:

- podcast feed/media/artwork hosts;
- PeerTube origins or their CDN/object-storage hosts;
- Owncast instance hosts;
- `cdn.media.ccc.de`, `static.media.ccc.de`, or `tile.loc.gov` merely because
  they carry media/assets.

Dynamic media belongs in `MediaRegistry`; dynamic artwork belongs in the asset
relay; dynamic catalog resolution belongs in the narrow catalog gateway.

## Error and exhaustion rules

A page/snapshot is accepted only after transport, content type, syntax, schema,
and provider-specific invariants pass.

| Condition | Result |
|---|---|
| Timeout/network/408/429/5xx | Retry same cursor after bounded cooldown |
| `Retry-After` present | Respect it, subject to a safe maximum |
| Expected JSON but HTML/CAPTCHA received | Provider cooldown; stale cache if available |
| GraphQL HTTP 200 with `errors` | Typed provider failure, not an empty page |
| Malformed XML/M3U/JSON | Retry/stale; never mark exhausted |
| Query search has validated zero results | Valid empty query result |
| Unfiltered catalog unexpectedly becomes zero | Retry and retain last-known-good before accepting |
| Finite page has authoritative no-next/end | `exhausted:true` |
| Live snapshot is empty but valid | Replace snapshot, schedule refresh; finite catalog unaffected |
| One podcast feed is dead | Record per-feed cooldown and continue other feeds |

Circuit breakers prevent repeated failures from hammering a provider. Manual
retry resets the breaker once; it does not create concurrent duplicate calls.

## Content preference and text safety

- `showExplicitContent` defaults to `false` and can become true only from its
  Settings control. Loading, migration, provider responses, favorites, or
  enabling a source cannot turn it on.
- Use one normalized item value: `content_rating` is `explicit`,
  `not-explicit`, or `unrated`. A shared predicate applies it before Library,
  search, Tuner, Grid, Discovery, details, random selection, and artwork work.
- While the preference is off, PeerTube requests `nsfw=false` and also filters
  any returned positive NSFW flags; when on, valid marked items may appear.
- Owncast always requires an exact boolean rating from the directory JSON. The
  setting decides whether verified `true` entries appear; it never permits a
  playlist entry with missing or malformed cross-check data.
- Podcast feed/channel/episode explicit flags are parsed. Positively marked
  items follow the setting; absent markers remain `unrated`.
- Existing `iptv-org` `is_nsfw:true` channels use the same preference instead
  of being irreversibly discarded during adapter loading.
- A preference change advances the catalog generation. Enabling it re-filters
  cached rated snapshots/feeds/IPTV data and refreshes PeerTube because its
  default-off requests exclude explicit results upstream. Disabling it cancels
  stale explicit resolution/artwork work before removing marked items.
- Explicit items are visibly labeled when enabled. Turning the preference off
  removes them from discovery and stops an explicit current playback/recording,
  but preserves any saved favorite as a nonrevealing "Hidden by content
  setting" placeholder so user data is never mistaken for deleted.
- Network trust is independent from content choice. Enabling explicit content
  does not permit private addresses, malformed URLs, unsafe redirects, invalid
  schemas, hidden/private PeerTube state, or unchecked Owncast entries.
- All provider strings are normalized, length-capped, stripped of controls and
  dangerous bidi controls where appropriate, and rendered with `textContent`.
- HTML descriptions are converted to bounded plain text. No provider markup is
  inserted with `innerHTML`.
- URL credentials, non-HTTP schemes, fragments where irrelevant, malformed
  IDNA, and private/non-global targets are rejected.
- Source links remain external links with existing opener protections.

## Test strategy

Automated tests must be fixture-first. Live services are an opt-in smoke layer,
never the only oracle.

### Deterministic frontend tests

- Registry metadata, settings migration, adapter lazy loading, and disabled
  sources.
- Default-off/explicit-on content preference, manual-only enablement,
  normalized rating, mode-wide filtering, labels, toggle-off teardown, and
  hidden-favorite restoration.
- Each adapter's browse/search/random/resolve/artwork contract.
- Stable IDs, URL normalization, language/year/license mapping, and exact
  duplicate suppression.
- Pagination, short nonterminal pages, Link parsing, interleaved lanes, and
  explicit exhaustion.
- Fair scheduler concurrency, cancellation, cooldown, Retry-After, circuit
  breaker, priority, and hidden-window pause.
- Snapshot replacement, stale retention, item update/removal, favorites/current
  preservation, and refresh timing.
- HTML/CAPTCHA/invalid JSON/GraphQL errors/suspicious zero behavior.
- Eleven-source sidebar, status row, Settings, About, search, Grid, Tuner,
  Discovery, filters, details, card uniformity, and keyboard behavior.
- Favorite rehydration without expired opaque URLs; EQ identity remains stable.

### Deterministic backend/security tests

- Feed resolver SSRF, DNS rebinding, redirect, credentials, URL length, port,
  timeout, compression, and response-size limits.
- XML entity/DTD/external reference, billion-laughs, quadratic, huge token,
  excessive depth/elements/attributes/text, malformed namespace, and encoding
  cases.
- RSS/Atom/Podcasting 2.0 enclosure/live/license fixtures.
- PeerTube resolver exact-origin API construction, off-origin redirect reject,
  public/privacy/state/content-rating validation in both preference states,
  schema drift, HLS/MP4 selection, and `downloadEnabled` behavior.
- Owncast parser quoted commas, multiline attributes/title, BOM/CRLF, malformed
  entries, duplicates, HTTP streams, bad schemes, private literals, NSFW join,
  missing safety JSON, and stale cache.
- Asset relay token scope, SSRF, redirects, MIME/magic mismatch, SVG/HTML reject,
  dimension/pixel/byte limits, TTL/LRU, request coalescing, and expiration.
- Cache atomicity, corruption, version migration, LRU, clear-cache semantics,
  and no secrets/tokens in persisted bytes.

### Playback/capture integration fixtures

- Direct MP3/MP4 podcast and CCC files with Range support.
- LOC-style streamed and download-restricted resource shapes.
- PeerTube VOD HLS plus downloadable MP4; live HLS with no download.
- Owncast/C3VOC live HLS with adaptive variants and interruption/recovery.
- Audio/video EQ playback, recording with EQ, stop recording without losing
  playback, unique filenames, and clean shutdown.

### Opt-in live matrix

Each provider gets a small, polite live probe that validates schema and one
representative media path without downloading a full file. LOC live probes run
under the 10/minute scheduler. Owncast live probes verify that every emitted
entry retains the exact joined NSFW rating. Results are diagnostic because live
content and network conditions change. The content matrix runs once with
explicit content off and once with it deliberately enabled, verifying
filtering and visible labels in both states.

### Build/release gates

```powershell
npm test
python -m unittest discover -s tests_python -p "test_*.py"
npm run build
git diff --check
python .\build_single_exe.py
python .\tests_python\single_exe_real_smoke.py
```

The packaged smoke must verify adapter chunks and `defusedxml` are included,
favorites/settings survive an upgrade, catalog/asset endpoints are reachable
only through the local authenticated app, and shutdown leaves no server,
FFmpeg, or helper process.

## Performance and observability requirements

- Existing sources must begin rendering without waiting for LOC, feeds, or
  federated origin resolution.
- No more than four source catalog operations are active globally.
- No more than four feed fetches or PeerTube origin details are active globally,
  with tighter per-host limits.
- No eager N+1 detail or thumbnail requests for off-screen cards.
- User play/download actions preempt low-priority catalog prefetch.
- Provider request, success, retry, stale-cache, parse reject, and latency
  counters are bounded/redacted and available in diagnostic logs.
- Logs contain source IDs and safe error codes, never full query strings with
  credentials, session tokens, local paths, raw feed content, or private IP
  probe detail.
- The UI differentiates loading, ready/more-available, finite complete, live
  snapshot, stale, retrying, rate-limited, and disabled.
- Phase 10 establishes measured startup, memory, scroll, search, and shutdown
  budgets on the packaged app. A regression outside the approved budget blocks
  release.

### Phase 10 measured budgets and final values (2026-07-15)

The evidence-based Phase 1/2 constants remain the final tuned values; the
combined measurements did not justify relaxing or tightening them:

| Resource | Final value |
|---|---:|
| Catalog scheduler | 4 global, 2/source; stricter provider gates remain authoritative |
| Artwork hydration/registration | 6 global, 3 bounded attempts |
| Prefetch reservoir | resume at 330 unseen items; pause at 660 |
| Resident catalog | 6,000 plus favorite/current/detail/visible pins |
| Mounted cards | 300-card sliding window |
| Catalog cache | 256 entries, 64/source, 2 MiB/entry, 64 MiB total |
| Artwork cache | 512 entries, 256 MiB total, 6-hour registration TTL |
| Live snapshots | provider hint clamped to 30 seconds-30 minutes; 2-minute default |

The exact final production bundle measured first card at 145.8 ms, rapid
debounced search at 462.2 ms, scroll-frame p95 at 24.5 ms, and exactly 300
mounted cards after accumulating more than 900 items. The deterministic
scheduler stress drained 2,200 operations across eleven sources with global
four/per-source one test limits and no starvation, duplication, or leak.

The isolated packaged 15-minute plateau stayed below the Phase 0
900/750-MiB working/private targets:

| Elapsed | Working set | Private | CPU seconds | Health latency |
|---:|---:|---:|---:|---:|
| 60 s | 593.855 MiB | 499.250 MiB | 18.516 | 2.884 ms |
| 300 s | 580.738 MiB | 483.566 MiB | 21.969 | 2.796 ms |
| 900 s | 578.730 MiB | 489.062 MiB | 26.625 | 2.373 ms |

All eleven adapter chunks loaded. Only 57 metadata proxy completions occurred
over 31 active seconds (maximum five in one logged second), resource use
settled rather than rising, and authenticated shutdown completed in 2.927
seconds. A separate 64-MiB relay benchmark transferred at 72.05 MiB/s with
0.381 MiB traced-memory growth and 2.223-ms control p95. During real FFmpeg
recording, control p95 was 2.984 ms; normalized FFmpeg CPU averaged 7.16% and
peaked at 15.82% of the machine's logical capacity.

### Final outbound classification

- Fixed metadata hosts are the original approved Radio Browser, iptv-org,
  Internet Archive, NASA, Wikimedia, and LibriVox hosts plus the ten exact new
  hosts in `FIXED_METADATA_HOSTS`. The generic proxy has no dynamic wildcard
  for feeds, instances, artwork, or media.
- Semantic dynamic routes accept one validated podcast feed URL, one exact
  PeerTube watch-origin/UUID pair, or the two fixed Owncast directory URLs.
  Every resolution and redirect crosses `SafeConnector` with pinned public DNS.
- Every provider thumbnail from all eleven sources is converted to an opaque
  `/api/v1/assets/{id}` route before any Library, detail, Grid, Discovery, or
  player `<img>` receives it. The relay enforces MIME/magic/dimensions/bytes.
- Every playable or downloadable provider URL is exchanged for an opaque
  `/api/v1/media/{id}` route. Capture jobs reference registrations, never raw
  request-supplied URLs.
- `source_url` is a credential-free canonical HTTP(S) link opened only by an
  explicit user action; it is never fetched as catalog, artwork, or media.

No outbound path remains unclassified.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Eleven-source startup overload | Fair global scheduler, provider buckets, bounded prefetch |
| PeerTube catalog is effectively unbounded | Resident ceiling, lazy pages, direct search, no attempt to ingest whole index |
| LOC CAPTCHA/one-hour block | Strict 10/minute shared bucket, Retry-After/cooldown, cache |
| Dead or hostile podcast feed | SafeConnector, defusedxml, hard budgets, per-feed isolation |
| Dynamic origin SSRF | Narrow semantic routes plus SafeConnector; no wildcard generic proxy |
| Malicious/huge thumbnail | Opaque image relay with MIME/magic/dimension/byte checks |
| Owncast M3U hides NSFW state | Mandatory JSON rating join; default-off filter; fail closed/stale cache if rating data is absent |
| Provider schema drift | Strict fixtures, typed validation, opt-in live probes, stale cache |
| Expired opaque URL in favorite | Canonical metadata persistence and per-session rehydration |
| Rights mislabel/download exposure | Provider-specific capability matrix; unknown stays unknown |
| Dynamic items disappear | Snapshot reconciliation preserves favorites/current playback |
| Source UI no longer fits | Independent scrolling, status overflow treatment, viewport tests |
| Dependency/package omission | Pin/license `defusedxml`, PyInstaller import smoke, notices update |

## Planning assumptions that must be revalidated during implementation

- Public endpoints remain no-key and available under their documented/current
  contracts.
- SepiaSearch continues to expose the current public search response. Its exact
  schema is fixture-guarded because the operational API is less formally
  documented than PeerTube's origin API.
- Owncast's `/api/home` remains available enough to rating-join the documented
  M3U. If it is removed, the source remains stale/unavailable until an official
  replacement carries NSFW state; the app must not expose unverified entries
  in either preference state.
- A nonempty C3VOC v2 live fixture can be captured before final release. Empty
  production data is valid between events.
- Phase 0 measurements determine final cache/item-memory ceilings. The design
  requires bounded values, but inventing the exact number before measurement
  would not be evidence-based.

Any material change to these assumptions must be recorded here before the
affected implementation phase proceeds.
