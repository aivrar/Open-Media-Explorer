# Five New Audio/Video Sources - Gated Execution Plan

Status: complete; Phases 0-11 and all ten quality gates passed on 2026-07-15
Created: 2026-07-14
Research basis: [FIVE_NEW_SOURCES_RESEARCH.md](FIVE_NEW_SOURCES_RESEARCH.md)

## Mission outcome

Add media.ccc.de/C3VOC, Library of Congress, gPodder podcasts, PeerTube, and
Owncast as complete World Media Windows sources, with no API keys and no gaps
across discovery, search, cards, details, thumbnails, favorites, playback,
download/record, EQ, settings, accessibility, caching, packaging, and shutdown.

The work is complete only when every phase gate and all ten final quality gates
pass. Passing tests alone is necessary but not sufficient.

## Execution contract

1. Execute phases in order. Do not begin a dependent phase while its
   prerequisite gate is open.
2. Re-read the relevant research sections before editing each phase.
3. Preserve all unrelated dirty-worktree changes. Never reset or overwrite the
   user's existing work to simplify a phase.
4. Record commands, results, manual observations, changed contracts, audit
   findings, and fixes in `docs/FIVE_NEW_SOURCES_EXECUTION_LOG.md` starting in
   Phase 0.
5. Add deterministic tests in the same phase as each behavior.
6. Live third-party services supplement fixtures; they are never the sole test
   oracle.
7. Do not weaken validation, security, content filtering, rate limits, or tests
   to make a phase pass.
8. If research assumptions change, update the research dossier and this plan
   before continuing.
9. Keep all five adapters out of the production registry until Phase 8. Earlier
   phases may import them directly in tests and development harnesses.
10. A phase is complete only after implementation, focused tests, full
    regression smoke, and the independent direct-code self-audit below.

## Mandatory end-of-phase sequence

Every phase uses this sequence without substitution:

1. **Implementation review** - inspect the phase diff for intended scope and
   accidental changes.
2. **Focused verification** - run the phase's deterministic unit/integration
   tests, including its negative and failure-path cases.
3. **Full smoke test** - run the standard regression commands and any listed
   packaged/live smoke appropriate to the phase.
4. **Independent self-audit after smoke** - stop relying on test results and
   reopen the changed production code. Trace every new path from input to
   normalization, orchestration, item model, UI/player/capture, persistence,
   error recovery, cancellation, and teardown. Compare it line by line with
   the research requirements and phase checklist.
5. **Repair loop** - fix every self-audit finding, rerun the affected focused
   tests and full smoke, then repeat the direct-code audit for the repaired
   area.
6. **Evidence entry** - record exact commands/results and the self-audit map in
   the execution log. Only then check off the exit gate.

The independent self-audit must explicitly answer:

- Are all callers and consumers connected?
- Are success, empty, stale, retry, rate-limit, abort, malformed, and shutdown
  paths connected?
- Can any failure be mistaken for exhaustion or success?
- Can any dynamic URL bypass `SafeConnector`, media relay, or asset relay?
- Can any ephemeral token be persisted?
- Are disabled sources and stale async completions prevented from mutating UI?
- Are rights, delivery, Download/Record, type, stream kind, and license honest?
- Are cleanup, listener removal, timers, jobs, files, and caches bounded?
- Do old six-source behavior and existing saved data remain intact?

## Standard regression commands

Run these after focused tests in every production-code phase:

```powershell
npm test
python -m unittest discover -s tests_python -p "test_*.py"
npm run build
git diff --check
```

Add these at package gates:

```powershell
python .\build_single_exe.py
python .\tests_python\single_exe_real_smoke.py
```

Any failure is resolved before the phase closes. A pre-existing failure must be
reproduced and documented with evidence; it is not silently ignored.

## Phase 0 - Freeze the baseline and evidence contracts

Goal: make later changes measurable without changing production behavior.

Research references: Current codebase audit; Test strategy; Planning
assumptions.

### Tasks

- [x] Create `docs/FIVE_NEW_SOURCES_EXECUTION_LOG.md` with phase, command,
  result, manual-smoke, self-audit, and open-risk sections.
- [x] Record the dirty-worktree baseline and identify which existing changes
  belong to prior completed player/capture/theme work.
- [x] Run and record the current JavaScript tests, Python tests, frontend build,
  syntax/import checks, and `git diff --check` before source work.
- [x] Capture current six-source behavior in deterministic contracts:
  registry IDs, settings migration, item model, browse-page shape, source
  status states, source switches, About entries, sidebar rows, and build chunks.
- [x] Capture current `iptv-org` `is_nsfw:true` exclusion and define the
  backward-compatible `content_rating` plus default-off preference contract.
- [x] Capture sanitized provider fixtures for:
  - media.ccc.de recent summary, event detail, GraphQL search, GraphQL error,
    empty live v2, and published nonempty live example;
  - LOC audio/video result, unrestricted item resource, restricted resource,
    pagination, 429, and CAPTCHA HTML;
  - gPodder toplist/search plus valid/dead/redirecting RSS, Atom, Podcasting
    2.0 live, explicit, and malicious XML;
  - SepiaSearch VOD/live summaries and public/private/NSFW/malformed origin
    details;
  - Owncast M3U and matching directory JSON containing safe, NSFW, malformed,
    HTTP, quoted-comma, and multiline entries.
- [x] Store fixture capture date, endpoint, status, content type, and a SHA-256
  of the sanitized fixture; remove volatile identifiers not needed by tests.
- [x] Measure current packaged/source-mode startup, first-card time, catalog
  concurrency, resident memory after 1/5/15 minutes, DOM card count, scroll
  responsiveness, search latency, and shutdown time.
- [x] Select and record evidence-based cache and resident-item ceilings from
  those measurements, with headroom for eleven sources.
- [x] Freeze proposed source IDs and stable-ID algorithms in tests.
- [x] Freeze `showExplicitContent:false` as the only migration/default state;
  no existing setting or source response may infer an enabled value.
- [x] Review `defusedxml==0.7.1` compatibility with the app's Python/PyInstaller
  runtime, hash/pinning policy, PSF license, and notice requirements.
- [x] Add no new source to `SOURCES` and make no production behavior change.

### Focused tests

- [x] Baseline UI and adapter contract fixtures pass unchanged.
- [x] Sanitized fixtures parse as their declared media type and contain no
  credentials, private URLs, session tokens, or personal local paths.
- [x] Benchmark harness produces repeatable machine-readable results.

### Smoke and independent self-audit

- [x] Standard regression commands pass.
- [x] Launch the current app, verify one old radio, IPTV, archive download,
  favorite, EQ, record, tab return, and shutdown path.
- [x] Audit the frozen contract from `sources.js` through the packaged frontend
  and confirm every later connection point is represented by a fixture/test.
- [x] Record the audit and any baseline limitations without changing scope.

### Exit gate

- [x] Baseline is green or every pre-existing failure is reproducibly isolated.
- [x] Fixture provenance and benchmark evidence are recorded.
- [x] Production diff for this phase contains no behavior change.

## Phase 1 - Build fair catalog orchestration and snapshot contracts

Goal: make eleven-source discovery bounded, fair, cancellable, and honest before
adding new network work.

Research references: Catalog operation scheduler; Finite pages and dynamic
snapshots; Cache and memory policy; Error and exhaustion rules.

### Tasks

- [x] Add a pure catalog scheduler with global concurrency 4, round-robin
  fairness, priority, queue deduplication, per-source cancellation, cooldown,
  visibility pause, and fake-clock seams.
- [x] Route initial browse, load-more, retry, and text-search fan-out through
  the scheduler for the existing six sources.
- [x] Preserve partial search rendering while limiting search concurrency.
- [x] Extend strict HTTP support with `getJson`, `getText`, and `postJson`, typed
  content/status errors, response budgets, `Retry-After`, GraphQL errors, and
  abort-safe retry behavior.
- [x] Keep compatibility wrappers only where existing adapters need a staged
  migration; no adapter may treat returned HTML as JSON.
- [x] Add optional adapter `refreshSnapshot()` orchestration independent from
  finite `browsePage()` cursors.
- [x] Add atomic per-source snapshot replacement and last-known-good/stale
  state without deleting a favorite/current/detail item.
- [x] Update duplicate handling so existing snapshot items can receive changed
  title/artwork/online metadata instead of being ignored.
- [x] Add bounded prefetch high/low-water marks and a resident-item ceiling from
  Phase 0 measurements.
- [x] Evict only oldest unseen nonfavorite/noncurrent/non-detail items and keep
  cumulative/session counts internally consistent.
- [x] Update status semantics to distinguish loading, more available, finite
  complete, live snapshot, stale, retrying/rate-limited, and disabled.
- [x] Extend the item model with normalized `content_rating` values
  `explicit`, `not-explicit`, and `unrated`, retaining backward compatibility
  for old items that have no rating field.
- [x] Ensure a disabled source cancels queued/in-flight work and stale
  completions cannot mutate current generation state.
- [x] Preserve the current retry rule: only explicit authoritative exhaustion
  retires a finite cursor.

### Focused tests

- [x] Global and per-source concurrency never exceed policy under browse and
  search storms.
- [x] A slow source cannot starve later sources; user play/detail work preempts
  low-priority prefetch.
- [x] Abort before queue, during fetch, during retry wait, and during mode/source
  change releases every slot and timer.
- [x] `Retry-After` and exponential fallback use fake time correctly.
- [x] HTML-as-JSON, malformed JSON, GraphQL errors, 429, 5xx, timeout, and abort
  never become empty/exhausted success.
- [x] Snapshot refresh adds, updates, removes, goes stale, recovers, and
  preserves favorite/current/detail items.
- [x] Memory eviction preserves pinned items, indexes, source/type counts,
  render window, and search results.
- [x] Existing six adapters retain page order, retries, and visible results.

### Smoke and independent self-audit

- [x] Standard regression commands pass.
- [x] Exercise six-source initial load, long scroll, rapid searches, disable and
  re-enable a source, sleep/wake/minimize, retry, and tab switching.
- [x] Audit scheduler slot acquisition/release, generation/abort ownership,
  timers, progress transitions, item/snapshot indexes, and all render callers.
- [x] Repair and repeat smoke/audit if any queue leak, false completion, stale
  mutation, count drift, or UI ambiguity is found.

### Exit gate

- [x] Existing source behavior is regression-clean under the new scheduler.
- [x] Concurrency, memory, and status contracts are deterministic and bounded.
- [x] No new provider adapter is registered.

## Phase 2 - Add the secure catalog gateway, cache, and asset relay

Goal: create one hardened backend boundary for federated feeds/details and
dynamic artwork before adapters depend on them.

Research references: Secure catalog gateway; Defended podcast feed parser;
Opaque asset relay; Fixed-host metadata proxy policy.

### Tasks

- [x] Add and pin `defusedxml==0.7.1` to build/runtime inputs and notices.
- [x] Add `worldmedia_catalog.py` with bounded shared cache, provider request
  policies, structured errors, redacted diagnostics, and injectable connector,
  clock, and storage seams.
- [x] Add authenticated same-origin feed resolve, PeerTube resolve, and Owncast
  snapshot routes with exact methods/content types/body limits.
- [x] Feed resolver: canonicalize HTTP(S), use `SafeConnector`, bound redirects,
  compressed/decoded bytes/time, parse with DTD/entities/external references
  forbidden, and enforce independent tree/emission limits.
- [x] Normalize RSS 2.0, Atom 1.0, Podcasting 2.0 enclosure/live/license,
  feed/episode explicit state, dates, language, artwork, stable identity inputs,
  and bounded plain text.
- [x] PeerTube resolver: accept watch URL and UUID only, construct exact origin
  detail path, forbid off-origin API redirects, validate schema/public state
  and content rating, and return normalized HLS/MP4/download choices.
- [x] Owncast gateway: fetch the two fixed endpoints, parse M3U with a state
  machine, rating-join exact online JSON metadata with a required boolean
  `nsfw` value, preserve that value, and fail closed to stale cache when rating
  metadata is missing.
- [x] Add a versioned atomic catalog cache under runtime cache/state root with
  ETag/Last-Modified, TTL, per-entry/total bounds, LRU, corruption recovery,
  last-known-good behavior, and clear-cache integration.
- [x] Add an opaque asset registry/handler with random scoped IDs,
  `SafeConnector`, MIME plus magic validation, JPEG/PNG/GIF/WebP dimension and
  pixel checks, byte cap, TTL/LRU, coalescing, Range/cache response policy where
  needed, expiration, and shutdown cleanup.
- [x] Add only the exact fixed metadata hosts approved in the research table.
- [x] Do not add wildcard dynamic-origin suffixes or reuse `/api/proxy` for
  arbitrary feeds, PeerTube origins, Owncast instances, or images.
- [x] Update PyInstaller/build manifests so `defusedxml` and new modules are
  included in source, folder, one-file, and portable outputs.

### Focused tests

- [x] Missing/wrong Host, Origin, token, method, content type, and oversized
  body fail before outbound work.
- [x] DNS rebinding, redirects to private/link-local/loopback, credentials,
  malformed IDNA, non-HTTP schemes, and unsafe ports/targets are rejected.
- [x] XML bombs, DTD/entities/external references, huge tokens, depth, elements,
  attributes, text, namespaces, compression, encoding, and malformed XML fail
  within time/memory budgets.
- [x] Valid RSS/Atom/Podcasting 2.0 fixtures normalize identically across common
  namespace/order variations.
- [x] PeerTube resolver rejects wrong UUID/origin redirects/private/
  unpublished/private/malformed data, preserves valid positive/negative
  ratings, and selects correct HLS/MP4/download.
- [x] Owncast parser handles current unusual quoted commas and multiline data;
  safe and explicit matches keep exact ratings and missing JSON cannot expose
  raw unrated M3U.
- [x] Asset relay rejects HTML/XML/SVG/MIME confusion/oversize/overdimension/
  expired/wrong-scope requests and coalesces valid repeated images.
- [x] Cache atomicity, conditional requests, stale fallback, suspicious zero,
  corruption, LRU, clear, and shutdown behavior pass.

### Smoke and independent self-audit

- [x] Standard regression commands pass.
- [x] Local hostile fixture server exercises every catalog/asset negative path.
- [x] Source-mode and one-file smoke import `defusedxml` and serve one valid
  feed, PeerTube detail, Owncast snapshot, and image entirely through localhost.
- [x] Audit every outbound call from route parsing through policy,
  `SafeConnector`, parser, cache, response serializer, opaque read, expiration,
  and shutdown. Confirm no dynamic URL reaches the generic proxy.
- [x] Search persisted cache/log bytes for tokens, cookies, credentials, local
  paths, private addresses, or raw malicious input.

### Exit gate

- [x] Security and package tests pass with no wildcard proxy expansion.
- [x] Dynamic catalogs/assets have a single auditable boundary.
- [x] No new provider adapter is registered.

## Phase 3 - Implement media.ccc.de / C3VOC adapter

Goal: add complete conference VOD plus an independently refreshing live lane.

Research references: media.ccc.de/C3VOC provider section; Rights matrix.

### Tasks

- [x] Add `src/adapters/media-ccc.js` with the standard exports and strict item
  normalization.
- [x] Browse `/public/events/recent` through RFC Link pagination, cache each
  100-event upstream page, and emit 30-item app pages without duplicates.
- [x] Parse Link relations by relation, not header position/string guessing.
- [x] Search with a fixed parameterized GraphQL query and page semantics; never
  fall back to the currently failing REST search endpoint.
- [x] Lazy-resolve event detail and select one compatible original-language
  MP4, or MP3 when video is unavailable; do not emit encoding duplicates.
- [x] Set finite delivery/download fields together and use official filenames.
- [x] Convert API HTML descriptions to bounded plain text.
- [x] Implement C3VOC `refreshSnapshot()` with conference/room stable IDs,
  native HLS preference, audio-only radio mapping, duplicate translation/slides
  suppression, valid-empty behavior, TTL, and stale recovery.
- [x] Use asset relay for poster/thumb URLs and retain canonical artwork for
  favorite rehydration.
- [x] Use explicit license metadata only when present; otherwise label
  "See event license" and preserve source/event links.
- [x] Implement cached `random()` without creating an uncontrolled extra API
  call for each Discovery render.

### Focused tests

- [x] 100-item upstream pages slice to app pages with correct cursor and exact
  Link-based exhaustion.
- [x] Duplicate GUIDs, null dates, missing resources, HTML, unsupported files,
  languages, and malformed fields normalize or skip safely.
- [x] GraphQL data/errors/empty page/transport failure have distinct outcomes.
- [x] VOD play/download and audio-only fallback capability fields are exact.
- [x] Empty and nonempty v2 snapshots refresh independently of VOD pagination.
- [x] Live native/HLS preference and stable IDs are deterministic.
- [x] Artwork registration and favorite rehydration use canonical, not opaque,
  persisted metadata.

### Smoke and independent self-audit

- [x] Standard regressions pass with adapter imported only by tests/harness.
- [x] Polite live probe fetches recent VOD, search, event resolution, and current
  live endpoint; play a short ranged VOD sample through the relay.
- [x] Local live fixture plays/records audio and video and recovers interruption.
- [x] Audit browse -> cursor -> item -> resolve -> media/asset registration ->
  capability -> favorite -> retry/snapshot -> shutdown connections.

### Exit gate

- [x] Complete media.ccc.de contract passes fixtures, live smoke, and audit.
- [x] Source remains absent from production registry until Phase 8.

## Phase 4 - Implement Library of Congress adapter

Goal: add heterogeneous LOC audio/video without rate abuse, false completion,
or rights mistakes.

Research references: Library of Congress provider section; Error/exhaustion
rules; Rights matrix.

### Tasks

- [x] Add `src/adapters/library-of-congress.js`.
- [x] Implement alternating audio and film/video cursor lanes so each app page
  uses one upstream catalog request and neither type starves.
- [x] Implement search with the same independent audio and film/video lanes,
  encoded query, alternating fairness, and per-lane cursors; a failed lane
  remains retryable without hiding valid results from the other lane.
- [x] Add one shared 10/minute burst-1 provider token bucket across browse,
  search, resolution, random, and retry.
- [x] Build JSON requests with minimum `at` fields and bounded page size.
- [x] Strictly validate content type, result array, pagination, canonical IDs,
  and provider totals before accepting a page.
- [x] Detect 429, CAPTCHA/HTML, provider errors, suspicious zero, and heavy-load
  failures; retain cursor/cache and enter provider cooldown.
- [x] Lazy-resolve item resources and traverse documented heterogeneous
  `audio`, `video_stream`, files, streams, derivatives, and MIME shapes.
- [x] Select only public supported playback resources.
- [x] Expose Download only when access, `download_restricted`, `canDownload`,
  and rights restriction signals permit it; restricted stream-only items stay
  playable without a Download button.
- [x] Normalize language/year/source/artwork and concise rights labels without
  assuming Public Domain.
- [x] Enforce the 100,000-item deep-page boundary with a truthful refine/search
  state rather than an upstream failure loop.
- [x] Cache summaries/details and use asset relay for dynamic LOC artwork.
- [x] Implement `random()` from bounded cached eligible summaries and resolve
  only the selected item; do not add an uncontrolled random catalog request.

### Focused tests

- [x] Fake clock proves no path exceeds one LOC request per six seconds,
  including concurrent search/play attempts.
- [x] Audio/video lanes advance, retry independently, and exhaust only from
  authoritative pagination.
- [x] Search query changes reset both search lanes; partial lane results,
  pagination, failure, retry, abort, and authoritative exhaustion are distinct.
- [x] CAPTCHA HTML, 429 with Retry-After, malformed JSON, heterogeneous missing
  fields, and suspicious zero never become complete.
- [x] Restricted, stream-only, downloadable, multi-resource, audio, and video
  fixtures select honest capabilities.
- [x] Rights text is bounded and unknown stays unknown.
- [x] Deep-page boundary, cache, abort, disable, and favorite re-resolution pass.

### Smoke and independent self-audit

- [x] Standard regressions pass with source unregistered.
- [x] Live smoke stays within logged rate budget and resolves one audio and one
  video item without downloading full media.
- [x] Local fixtures play/download allowed media and suppress restricted media.
- [x] Audit token-bucket ownership, every resource-selection branch, rights
  decisions, cursor preservation, cache state, and shutdown timer cleanup.

### Exit gate

- [x] LOC adapter is rate-safe, rights-safe, retry-safe, and fully audited.
- [x] Source remains absent from production registry until Phase 8.

## Phase 5 - Implement gPodder podcast adapter

Goal: turn a no-key podcast directory into safe, fair episode discovery without
letting dead or hostile publisher feeds destabilize the app.

Research references: gPodder and publisher feeds; Defended feed parser; Stable
identity; Rights matrix.

### Tasks

- [x] Add `src/adapters/gpodder.js` using directory endpoints only for show
  discovery and the Phase 2 feed resolver for episodes.
- [x] Browse a cached toplist snapshot of at most 100 shows.
- [x] Interleave bounded recent episodes across feeds; track feed index,
  episode position, attempted/dead feeds, and snapshot identity in the cursor.
- [x] Limit directory calls to provider policy, feed work to global 4/per-host
  1, and abort all outstanding feed work when generation/source changes.
- [x] Return short nonterminal pages honestly when a feed batch yields fewer
  than 30 episodes.
- [x] Search gPodder, then resolve only a bounded candidate subset and match
  normalized show/episode metadata.
- [x] Map finite RSS/Atom enclosures to on-demand audio/video with Download.
- [x] Map only currently live Podcasting 2.0 items to radio/TV Record actions.
- [x] Prefer compatible standard/default MP3/H.264 MP4/HLS and ignore
  unsupported transports/codecs.
- [x] Normalize explicit feed/episode markers into `content_rating`; hide
  positive markers by default and include them with labels only when the
  explicit-content preference supplied to the adapter is true.
- [x] Safely normalize language/date, license, source, filename, description,
  and artwork.
- [x] Use backend stable IDs and redirect aliases; never use title alone.
- [x] Keep a dead-feed cooldown/last-known-good cache without marking the whole
  source failed or exhausted.
- [x] Use opaque asset relay for feed/episode artwork and canonical metadata for
  favorites.
- [x] Implement `random()` from cached normalized eligible episodes without
  starting a new directory/feed fan-out.

### Focused tests

- [x] Toplist/search responses, no pagination, directory failure, dead feed,
  redirect, conditional 304, duplicate feed/episode, and changed feed URL pass.
- [x] Four-feed fairness and per-host concurrency are deterministic.
- [x] RSS, Atom, relative URLs, CDATA HTML, missing GUID, duplicate GUID,
  enclosure MIME/extension disagreement, explicit flags, license inheritance,
  alternate enclosure, and live status cases normalize correctly.
- [x] Explicit true/false/missing feed and episode combinations produce the
  correct rating and results with the preference off and deliberately on.
- [x] A short page does not exhaust unattempted feeds; all-attempted feeds do.
- [x] Feed failure/cooldown/stale recovery cannot block good feeds.
- [x] Finite download, audio/video playback, live record capability, artwork,
  favorite rehydration, abort, and source disable pass.
- [x] All Phase 2 malicious XML/security fixtures remain green through the
  adapter call path, not only the backend unit boundary.

### Smoke and independent self-audit

- [x] Standard regressions pass with source unregistered.
- [x] Live smoke searches one term and processes a small capped feed set with
  logged concurrency and no full episode download.
- [x] Play and download one short fixture episode; play/record local podcast
  live audio/video fixtures.
- [x] Audit directory -> feed queue -> backend parser -> normalized episode ->
  item/cursor -> asset/media -> capability/favorite -> cache/retry/teardown.

### Exit gate

- [x] gPodder remains useful when some feeds are dead and secure when one is
  malicious.
- [x] Source remains absent from production registry until Phase 8.

## Phase 6 - Implement PeerTube adapter

Goal: add global federated VOD/live discovery while treating every origin as
untrusted and respecting content/download state.

Research references: PeerTube through SepiaSearch; Secure catalog gateway;
Rights/content preference.

### Tasks

- [x] Add `src/adapters/peertube.js`.
- [x] Browse SepiaSearch with `start`, `count`, recent sort, and scheduled-live
  exclusion; while the preference is off request `nsfw=false`, and only when
  it is explicitly on omit that exclusion. Search follows the same rule.
- [x] Validate every summary's public privacy, well-formed NSFW/flag state,
  UUID, canonical HTTPS/HTTP watch URL, and bounded fields; retain the rating.
- [x] Build stable IDs from normalized origin host plus UUID.
- [x] Lazy-resolve through the Phase 2 semantic PeerTube route and revalidate
  public, published, and rating state at the origin. A marked item resolves
  only while the explicit-content preference is enabled.
- [x] Prefer a public HLS master; fall back to compatible public MP4.
- [x] Map active live to TV/Record and VOD to video/on-demand.
- [x] Expose Download only when `downloadEnabled:true` and a concrete public
  download file exists; choose a compatible deterministic rendition.
- [x] Preserve license label including All Rights Reserved, language, channel,
  tags, dates, and canonical source link.
- [x] Use asset relay for thumbnails/previews; never request origin images
  directly from the WebView.
- [x] Cache summary/detail by origin+UUID, coalesce resolution, honor per-origin
  rate headers, and isolate one broken origin.
- [x] Implement random from a cached bounded Sepia page rather than arbitrary
  origin fan-out.

### Focused tests

- [x] Browse/search offsets, totals, empty query, validated zero, suspicious
  unfiltered zero, malformed Sepia data, 429, and schema drift pass.
- [x] Private, unlisted, scheduled, unpublished, malformed rating, valid
  NSFW/flagged, wrong UUID, origin redirect, missing files, live, and VOD
  details map correctly in both preference states.
- [x] HLS/MP4 fallback and rendition/download selection are deterministic.
- [x] License values 1-9 display correctly and never substitute for
  `downloadEnabled`.
- [x] One failing/rate-limited origin does not poison other cards or source
  pagination.
- [x] Artwork, favorite restart, duplicate federated result, abort, source
  disable, and stale-detail recovery pass.

### Smoke and independent self-audit

- [x] Standard regressions pass with source unregistered.
- [x] Live smoke browses/searches Sepia and resolves one public VOD and one
  current live item when available, without full download.
- [x] Local fixtures cover VOD play/download and live play/record/EQ.
- [x] Audit index URL -> stable identity -> semantic resolver -> origin policy ->
  media/asset relay -> capability/license -> favorite/cache -> cleanup.

### Exit gate

- [x] No dynamic PeerTube host enters the generic proxy and all content/state
  filters pass.
- [x] Source remains absent from production registry until Phase 8.

## Phase 7 - Implement Owncast adapter

Goal: add a refreshing live directory whose content rating is always verified
and whose explicit entries follow the user's default-off preference.

Research references: Owncast Directory; Dynamic snapshots; Content preference.

### Tasks

- [x] Add `src/adapters/owncast.js` backed exclusively by the normalized Phase
  2 snapshot route.
- [x] Implement snapshot-only browse behavior with two-minute refresh, manual
  retry, last-known-good stale state, and no permanent exhaustion.
- [x] Search/filter the current normalized snapshot locally; do not refetch on
  every keystroke.
- [x] Map exact directory playlist URI to live HLS TV/Record video.
- [x] Use normalized instance base URL for stable identity and source link.
- [x] Normalize title/description/tags, label independent rights honestly, and
  use asset relay for logos.
- [x] Preserve the verified `nsfw` boolean as `content_rating`; hide explicit
  entries by default and include them with visible labels only when the user
  has explicitly enabled the setting.
- [x] Preserve a favorited/offline Owncast item while removing it from the
  current live snapshot; revalidate when the user later selects it.
- [x] Ensure valid zero-live snapshot displays a refresh state, not a permanent
  completed archive.
- [x] Implement `random()` strictly from the current verified and preference-
  filtered snapshot; an empty snapshot yields no item and does not trigger an
  extra refresh.

### Focused tests

- [x] Verified snapshot add/update/remove/stale/recovery and exact stable IDs
  pass.
- [x] Every NSFW fixture is absent with the preference off and present with a
  visible label when deliberately on; missing/invalid rating JSON cannot expose
  M3U entries in either state.
- [x] HTTP and HTTPS public live URLs pass only through media relay;
  credentials/private/bad schemes are rejected.
- [x] Local search, random, duplicate origin, zero snapshot, favorite offline,
  artwork, disable, abort, and refresh timer cleanup pass.
- [x] M3U parser regression corpus remains green through full gateway-adapter
  integration.

### Smoke and independent self-audit

- [x] Standard regressions pass with source unregistered.
- [x] Live smoke compares normalized results with current directory data in
  both preference states and verifies exact filtering/labels for known ratings.
- [x] Play and briefly record one safe reachable stream; an unreachable stream
  fails without blocking snapshot refresh or shutdown.
- [x] Audit fixed directory fetches -> safety join -> snapshot -> item -> asset/
  media -> record/favorite -> offline reconciliation -> timer/shutdown.

### Exit gate

- [x] Owncast is snapshot-correct, preference-correct, and teardown-clean.
- [x] Source remains absent from production registry until Phase 8.

## Phase 8 - Register all five sources and complete UI/settings integration

Goal: expose the proven adapters everywhere in one controlled integration
change and make the eleven-source UI coherent at all supported sizes/themes.

Research references: Settings/modes/UI; Source IDs; Stable identity.

### Tasks

- [x] Add all five registry entries and lazy loaders together.
- [x] Extend registry metadata with homepage, description, rights note, and
  capabilities; render Settings and About from the registry.
- [x] Remove hard-coded duplicate About/source color and settings source lists.
- [x] Verify settings migration preserves every existing source choice and
  defaults the five new source IDs on without resetting theme, quality, EQ,
  favorites, or other settings.
- [x] Add a Settings content section with an accessible
  `Show explicit/NSFW content` toggle backed by `showExplicitContent`. It is
  off by default and can become on only through that direct user action.
- [x] Ensure fresh, legacy, partial, corrupt, and future settings always default
  a missing/invalid explicit-content field to false; enabling sources, loading
  favorites, or receiving provider data must never enable it.
- [x] Apply one shared content-rating predicate in Library, search, Tuner,
  Grid, Discovery, details, random selection, and thumbnail scheduling. Use it
  for new providers and replace `iptv-org`'s irreversible load-time NSFW drop.
- [x] On preference change, advance the catalog generation and cancel stale
  work. Re-filter cached podcast/Owncast/IPTV data locally; when enabling,
  reset and refresh PeerTube browse/search because default-off upstream
  requests intentionally excluded marked results.
- [x] Display a clear Explicit/NSFW badge on marked content when enabled.
  Turning the setting off removes marked items, stops marked playback/recording,
  and preserves marked favorites as nonrevealing hidden placeholders that are
  restored when the user opts in again.
- [x] Add distinct theme-compatible source colors with contrast checks; never
  use color as the sole status/type signal.
- [x] Make Library source list independently scrollable, keep active/focused
  row visible, and prevent player bar overlap at minimum supported viewport.
- [x] Make eleven status pills wrap or scroll accessibly without clipping the
  search/filter row.
- [x] Integrate source filters/counts/status in Library, Tuner, Grid, Discovery,
  details, favorites, search, and retry.
- [x] Ensure mode navigation and Library remount preserve selected source,
  detail panel, loaded pool, snapshot timers, and player bar.
- [x] Update baseline UI contract, adapter fixture matrix, production UI
  harness, source real-smoke matrix, build chunk expectations, and test page.
- [x] Ensure disabling a source removes/pauses its nonfavorite discovery data
  and work without deleting saved favorites.
- [x] Add clear user-facing provider descriptions that distinguish archives,
  podcast directory, federated index, and live directory.

### Focused tests

- [x] Exactly eleven unique registry IDs, loaders, settings switches, sidebar
  rows, source descriptions, and production chunks exist.
- [x] Legacy/partial/corrupt/future settings migration preserves old choices
  and creates only valid new-source booleans while keeping explicit content
  off unless the stored field is exactly a prior user-selected true.
- [x] The preference cannot be enabled by migration, source toggle, adapter
  return, URL, favorite import, or malformed storage; direct Settings action is
  the only enable path.
- [x] Preference-off/on transitions filter and relabel iptv-org, podcasts,
  PeerTube, and Owncast consistently across every mode, performing only the
  required PeerTube refresh and no duplicate/refetch loop.
- [x] Turning it off stops marked playback/capture cleanly and never deletes a
  favorite or its EQ association.
- [x] Each mode filters/renders all applicable types and no mode hard-codes six.
- [x] Source disable/re-enable, status, counts, retries, search, favorites, and
  mode remount pass with in-flight work.
- [x] Viewport tests cover minimum, 1366x768, 1920x1080, maximized, high DPI,
  long localized titles, all themes, player bar present, and details open.
- [x] Keyboard focus order/visibility and semantic labels work through all 11
  rows and status controls.

### Smoke and independent self-audit

- [x] Standard regressions and production UI harness pass.
- [x] Launch the source build and visit every mode, enable/disable every new
  source, search one query, scroll each source, open details, favorite one item,
  and switch themes/window sizes.
- [x] With explicit content off, verify no marked fixture in any applicable
  source or mode. Deliberately enable it in Settings, verify labeled marked
  fixtures appear, then disable it and verify teardown/data preservation.
- [x] Audit registry metadata consumers with `rg` and direct code review; prove
  no stale hard-coded six-source list/map remains in production or tests.
- [x] Trace settings migration and every source state through mode unmount/remount
  and shutdown.

### Exit gate

- [x] All five sources are visible and coherent in every applicable mode.
- [x] UI remains usable with player/details at supported sizes and themes.
- [x] No incomplete/duplicate registry metadata path remains.

## Phase 9 - Prove playback, Download/Record, EQ, and favorites end to end

Goal: connect every new item class to the already hardened media/capture/EQ
system and verify restart behavior.

Research references: Item contracts; Rights/capability rules; Favorite
rehydration; Playback/capture fixtures.

### Tasks

- [x] Verify each adapter populates delivery, stream kind, download URL/name,
  headers, resolver state, and license atomically.
- [x] Make capability checks wait for lazy resolution once and settle to an
  honest final action; a permanently restricted item must not remain Checking.
- [x] Route all new playback through media registration and same-origin relay;
  no adapter attaches remote media directly.
- [x] Preserve HLS master adaptation for C3VOC, podcast live, PeerTube, and
  Owncast; direct finite files preserve Range/seeking.
- [x] Verify finite CCC, LOC, podcast, and allowed PeerTube items download with
  backend-sanitized unique human-readable filenames.
- [x] Verify live C3VOC/podcast/PeerTube/Owncast items record audio/video with
  selected quality, EQ snapshot, unique timestamp, progress, stop, completion,
  open-folder, cancellation, and shutdown semantics.
- [x] Verify stopping a recording never tears down or replaces the live player
  registration.
- [x] Ensure EQ applies immediately to all new playback and is included in
  recordings exactly as current policy specifies.
- [x] Favorite/unfavorite auto-saves effective EQ using stable IDs.
- [x] On restart, clear expired media/asset tokens, re-resolve stream/artwork,
  and preserve favorite/EQ/settings without a manual cache reset.
- [x] If a dynamic favorite is offline/restricted/removed, retain it with an
  honest unavailable state and canonical source link.
- [x] Verify source changes and rapid play requests cancel stale resolution and
  cannot overwrite the current player.

### Focused tests

- [x] Capability matrix covers every row in the research dossier before/after
  lazy resolution, restriction, and failure.
- [x] Direct MP3/MP4, Range, HLS VOD/live, HTTP media, CDN redirect, headers,
  interruption, resume/retry, record, download, and EQ fixtures pass.
- [x] Download/record filenames never collide and remain Windows-safe.
- [x] Record stop/cancel/shutdown leave playback alive where specified and
  leave no FFmpeg/temp/job/relay leak.
- [x] Favorite reload has no expired opaque URL and preserves EQ scope.
- [x] Explicit favorites and EQ survive an off/on preference cycle without
  exposing title/artwork while hidden or appearing deleted.
- [x] Rapid source/item/mode changes ignore stale async completions.
- [x] Existing six-source playback/download/record/EQ/favorites remain green.

### Smoke and independent self-audit

- [x] Standard regressions pass.
- [x] Manual matrix exercises at least one representative item for every
  reachable new source and every capability class; use local fixtures when no
  live upstream event exists.
- [x] Restart the app between favorite creation and replay for all five source
  identities.
- [x] Audit item -> lazy resolver -> capability -> media registration -> player/
  download/record -> EQ -> favorite persistence -> restart -> teardown for each
  matrix row. Compare code branches, not only visible output.

### Exit gate

- [x] All capability and favorite/EQ paths are connected and honest.
- [x] Existing playback/capture regressions remain absent.

## Phase 10 - Full-load reliability, performance, privacy, and security audit

Goal: harden the combined eleven-source system under realistic load and hostile
failure combinations.

Research references: Performance/observability; Risks/mitigations; Test
strategy.

### Tasks

- [x] Run eleven-source cold/warm/offline/slow/partial-outage sessions at the
  Phase 0 time intervals and compare first-card, memory, CPU, requests, DOM,
  scroll, search, player, and shutdown metrics.
- [x] Tune only within documented bounds: global/per-provider concurrency,
  prefetch watermarks, cache TTL/size, resident ceiling, snapshot intervals,
  and retry/circuit-breaker delays.
- [x] Prove one blocked/slow provider cannot delay old source cards, user play,
  settings, mode navigation, recording controls, or shutdown.
- [x] Exercise simultaneous LOC cooldown, dead feeds, broken PeerTube origins,
  Owncast safety-metadata failure, C3VOC empty live, and old-source retries.
- [x] Verify hidden/minimized windows pause low-priority work and resume without
  duplicate queues or lost cursors.
- [x] Verify stale cache labels and recovery; suspicious empty data never wipes
  good cached catalogs.
- [x] Run repeated long scroll/search/filter/theme/mode cycles and ensure item,
  snapshot, observer, listener, timer, abort controller, relay, cache, and job
  counts return to bounded levels.
- [x] Re-run the complete SSRF/XML/M3U/image/content-safety suites through the
  packaged server boundary.
- [x] Verify no known NSFW/explicit fixture escapes and no provider HTML reaches
  the default-off filter; with the setting deliberately on, marked fixtures are
  labeled and still pass every network/schema/media validation. No provider
  HTML reaches rendering as active markup.
- [x] Inspect logs/cache/localStorage/download metadata for secrets, opaque
  tokens, raw malicious content, private endpoints, and overlong unredacted URLs.
- [x] Review dependency licenses/notices and PyInstaller contents.
- [x] Document measured budgets and final tuned values in research/execution
  docs.

### Focused tests and stress smoke

- [x] Automated performance harness meets approved first-card, memory, DOM,
  control latency during recording, and shutdown budgets.
- [x] Scheduler property/stress tests show no starvation, slot leak, duplicate
  work, timer leak, or false completion over thousands of simulated operations.
- [x] Cache/eviction stress preserves pinned/favorite/current items and count
  consistency.
- [x] Fault-injection run recovers every provider independently.
- [x] Security regression suite passes in source and packaged modes.

### Independent self-audit

- [x] Build a connection map of all outbound domains and prove each is fixed
  metadata, semantic catalog, opaque asset, or opaque media - never unclassified.
- [x] Build a lifecycle map of scheduler queues, snapshots, cards, media/assets,
  jobs, caches, and shutdown and inspect every ownership/cleanup edge.
- [x] Build a failure-state map from each provider to UI status and prove no
  failure becomes complete or silently disappears.
- [x] Build a rights/content map from upstream flags to item fields/buttons and
  inspect every branch.
- [x] Repair, rerun stress/full smoke, and repeat the affected audit maps.

### Exit gate

- [x] Eleven-source measured budgets pass without accepting unexplained
  regression.
- [x] Security, privacy, content, rights, failure, and cleanup maps have no gap.
- [x] No unresolved severity-high/medium defect remains.

## Phase 11 - Accessibility, documentation, single-EXE release, and final audit

Status: complete on 2026-07-15.

Goal: produce the usual Windows artifact with complete documentation and
objective 10/10 evidence.

Research references: Build/release gates; Final quality rubric.

### Tasks

- [x] Run keyboard-only access through navigation, source sidebar, search,
  filters, cards, details, player, Download/Record, EQ, Settings, retry/status,
  and shutdown at all supported layouts.
- [x] Verify screen-reader names/states for source status, live/stale/retrying,
  card metadata, play/pause, capability actions, recording progress, and errors;
  live regions announce transitions without per-second chatter.
- [x] Verify high contrast, focus rings, zoom/high DPI, light/dark/all custom
  themes, native title bar theme, reduced motion, and color-independent status.
- [x] Update README, About, Settings source copy, CREDITS, CHANGELOG, file tree,
  build/release docs, troubleshooting, privacy/network behavior, rights notice,
  and third-party notices.
- [x] Document every provider endpoint, cache/refresh behavior, no-key status,
  explicit-content default/enable behavior, opt-in live smoke, and user-visible
  limitations.
- [x] Run the complete deterministic suite from a clean build input while
  preserving the user's worktree.
- [x] Build frontend, owner-preferred `dist\WorldMediaWindows.exe`, folder
  fallback, and portable ZIP with the normal build script.
- [x] Record artifact path, size, SHA-256, and filesystem timestamp.
- [x] Run packaged real smoke for all eleven source registrations, catalog and
  asset routes, settings/favorites migration, playback/capture/EQ, themes,
  restart, and shutdown/no-orphan processes.
- [x] Run polite opt-in live matrix and record volatile failures separately
  from deterministic defects.
- [x] Remove temporary diagnostics/feature flags/fixture secrets and verify no
  test-only route or debug bypass ships.

### Final smoke

- [x] `npm test` passes.
- [x] Full Python unittest discovery passes.
- [x] `npm run build` passes.
- [x] `git diff --check` passes.
- [x] Single-EXE build and packaged real smoke pass.
- [x] Production UI harness and source fixture matrix pass for all 11 sources.
- [x] Manual packaged capability/accessibility matrix passes.
- [x] Shutdown exits UI, local server, FFmpeg, recordings, downloads, catalog
  work, and helper processes within the approved bound.

### Independent final self-audit after smoke

- [x] Reopen the final production code after every final smoke item passes and
  perform the direct-code audit across every phase; reconcile the research
  dossier, tasklist, execution log, tests, built files, and user-visible
  behavior.
- [x] Rebuild the input-to-output connection, lifecycle/cleanup,
  failure/status, rights/capability, persistence/migration, and outbound-domain
  maps from the shipped code rather than copying earlier phase conclusions.
- [x] Repair every finding, rerun affected focused tests and the complete final
  smoke, then repeat this independent audit before closing any exit gate.

### Exit gate

- [x] All documentation and artifacts match the tested code.
- [x] No unresolved required task, test failure, audit finding, or release
  blocker remains.
- [x] All ten quality gates below are evidenced as pass.

## Final 10/10 quality rubric

The addition receives one point only when the corresponding evidence gate is
fully satisfied. There are no partial points and no compensating strengths.

| Point | Quality gate | Required evidence |
|---|---|---|
| 1 | Contract correctness | All five adapters satisfy strict item/page/snapshot/resolve/artwork contracts and deterministic fixtures |
| 2 | Feature completeness | Browse, search, random/Discovery, filters, details, all modes, settings, About, and 11-source registry are connected |
| 3 | Reliability | Retry, rate limit, stale cache, suspicious zero, partial failure, cancellation, snapshot refresh, and shutdown recover correctly |
| 4 | Security/privacy | SSRF, XML, M3U, image, origin/token, cache/log, and dynamic-host boundaries pass source and packaged audits |
| 5 | Rights/content preference | Explicit content is manual opt-in and correctly filtered/labeled in both states; provider restrictions and licenses/actions remain honest |
| 6 | Performance | Measured concurrency, first-card, memory, DOM, search, scroll, control latency, and shutdown budgets pass |
| 7 | Playback/capture | Direct/HLS audio/video, adaptation, Download/Record, EQ, stop/cancel, filenames, and old-source regressions pass |
| 8 | Persistence/migration | Existing settings/favorites survive; new IDs/EQ persist; opaque tokens never persist; dynamic favorites rehydrate |
| 9 | UI/accessibility | Eleven-source layouts, themes/title bar, keyboard, screen reader, focus, zoom/DPI, and responsive player/details pass |
| 10 | Release evidence | Full suites, independent audits, docs/notices, usual single EXE, portable outputs, live diagnostics, hashes, and no-orphan shutdown pass |

Final rating rule:

```text
10/10 = all 10 gates pass and every phase exit gate is closed.
Anything else = incomplete; report the exact open gate instead of rounding up.
```

## Completion definition

The mission is complete only when a user can install or open the usual Windows
EXE, retain existing data, enable any of eleven sources, discover/search all
five additions without startup overload, see safe and accurate cards, play or
capture only according to real capability, keep favorite EQ behavior across
restart, survive provider failures without false completion, and shut down with
no process left behind - with deterministic tests and independent code audits
proving every connection.
