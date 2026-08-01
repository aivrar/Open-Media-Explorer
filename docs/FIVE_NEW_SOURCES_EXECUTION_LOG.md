# Five New Sources - Execution Log

This is the durable evidence log for `FIVE_NEW_SOURCES_PHASES.md`. Commands are
run from `E:\WorldMediaWindows` unless noted. A phase closes only after its
implementation, focused smoke, full regression smoke, and separate direct-code
self-audit are recorded here.

## Mission controls

- Completed goal (2026-07-15): implement media.ccc.de/C3VOC, Library of
  Congress, gPodder, PeerTube, and Owncast through all eleven phases.
- Existing user changes are owned by the user and are never reset, reverted,
  or silently reformatted.
- Normal user state is out of bounds for automated mutation. Native tests set
  `WORLDMEDIA_STATE_ROOT` to a disposable directory. The production favorites
  key `worldmedia.favorites.v1` and EQ key `worldmedia.eq.v1` are frozen in the
  Phase 0 contract.
- The only user-facing action that may clear favorites remains the existing
  separately confirmed Clear Data control. No source migration may invoke it.

## Phase 0 - Baseline and evidence contracts

Status: complete.

### Repository baseline

- Captured: 2026-07-14 (America/Chihuahua).
- Branch: `main`.
- HEAD before phase work: `ca2ea7eefe951558b3456adfd379fb84faa2bc98`.
- Dirty baseline before phase work: 59 tracked files changed, approximately
  4,731 insertions and 1,306 deletions, plus 104 untracked files. These are the
  user's prior player, capture, EQ, discovery, thumbnail, theme, and archive
  changes; Phase 0 does not claim ownership of them.
- Baseline artifact: `dist/WorldMediaWindows.exe`, 18,878,686 bytes,
  modified `2026-07-14T16:22:32.7177730-07:00`, SHA-256
  `fcd3b826a12afefffd65580ed9eb97b753293e991d3f8ff5f1cc3b59cf6ee9e1`.
- Toolchain: Node 24.11.1, npm 11.12.1, Python 3.13.11, PyInstaller 6.21.0,
  Vite 8.1.4, app 0.1.2.

### Pre-change regression baseline

| Gate | Result | Evidence |
|---|---:|---|
| JavaScript | 89/89 passed | `npm test`, 10.77 seconds |
| Python | 98/98 passed | `python -m unittest discover -s tests_python -p "test_*.py"`, 50.63 seconds |
| Frontend build | Passed | 61 modules, 6.98 seconds; only pre-existing chunk/CommonJS/dynamic-import warnings |
| Python compile | Passed | All production and build modules compiled |
| Diff check | Passed | `git diff --check`; only line-ending conversion warnings |

### Frozen provider and persistence contracts

- `tests/fixtures/five-new-sources/contracts.json` freezes the five source IDs,
  exact stable-ID rules and vectors, normalized content-rating values,
  `showExplicitContent:false`, Phase 8 registration boundary, favorites key,
  EQ key, and test-state isolation rule.
- `src/lib/sources.js` remains exactly the original six-source registry in
  Phase 0. All five proposed source IDs are proven absent by test.
- The current `iptv-org` irreversible `is_nsfw:true` exclusion is frozen as a
  migration baseline. It is not changed until the shared Phase 8 content
  predicate exists.
- Read-only verification found the normal favorites key in the normal WebView2
  LevelDB. No automated phase run opened that profile; all native processes in
  this phase used `%TEMP%\WorldMediaPhase0-*` or a temporary directory.

### Sanitized fixture corpus

`tests/fixtures/five-new-sources/manifest.json` records capture date, endpoint,
status, declared content type, cases, and raw-byte SHA-256 for every fixture.
`.gitattributes` pins this corpus to LF so hashes remain portable.

Covered cases:

- media.ccc.de recent/detail, GraphQL success/error, empty live, and a nonempty
  published C3VOC v2 shape;
- LOC audio/video pages, allowed download, restricted stream, 429/Retry-After,
  and CAPTCHA HTML where JSON was expected;
- gPodder top/search, redirect/dead/upstream/timeout outcomes, RSS, Atom,
  Podcasting 2.0 live, explicit, malformed, DTD/entity/external-reference, and
  loopback-enclosure XML;
- SepiaSearch/PeerTube public VOD, live, explicit, private, unpublished,
  malformed, HLS, MP4 download, and rate-limit shapes;
- Owncast matching M3U and home JSON for safe, explicit, HTTP, quoted-comma,
  multiline, missing-rating, malformed-rating, bad-scheme, missing-URI, and
  featured cases.

Focused smoke:

- `node --test tests/five-new-sources-baseline.test.js`: 5/5 passed.
- `python -m unittest tests_python.test_five_new_source_fixtures -v`: 5/5
  passed.
- Checks include exact hashes, complete manifest coverage, JSON/media-type
  parsing, benign XML well-formedness, declared hostile XML, no credentials or
  personal paths, stable vectors, production-registry absence, mandatory
  Owncast boolean-rating joins, and the original six-source paging/status,
  sidebar, About, settings-migration, and built-chunk connections.

### Dependency decision: defusedxml 0.7.1

- Decision: approved for Phase 2, pinned to `defusedxml==0.7.1` and wheel
  SHA-256 `a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61`.
- PyPI provides a 25,604-byte `py2.py3-none-any` pure-Python wheel. Metadata
  allows Python versions newer than 3.4 and declares the PSF License.
- Local Python 3.13.11 imported 0.7.1, parsed safe XML, and rejected the hostile
  DTD/entity probe.
- PyInstaller 6.21.0 built a one-file probe without a defusedxml missing-module
  warning; the frozen executable ran and reported safe root `rss` and
  `hostile_rejected:true`.
- The wheel contains `defusedxml-0.7.1.dist-info/LICENSE`. Phase 2 must copy
  that license into release notices and include the pinned requirement/hash in
  source, portable-folder, and one-file build inputs.
- Primary references: [PyPI release and hashes](https://pypi.org/project/defusedxml/),
  [PyInstaller hook behavior](https://pyinstaller.org/en/latest/hooks.html).

### Performance and workload baseline

The repeatable opt-in harness is
`tests_python/five_source_baseline.py`. It launches isolated source/packaged
instances, samples complete process trees, probes health latency, summarizes
request logs, and performs authenticated shutdown. It emits JSON and explicitly
leaves unavailable visual metrics null rather than substituting proxy timing.

Harness self-smoke (`--mode both --targets 2,4 --backend-only`):

| Case | Health startup | Working set | Private | Health latency | Shutdown |
|---|---:|---:|---:|---:|---:|
| Source | 1.261 s | 43.969 MiB | 29.422 MiB | 2.3 ms | 0.262 s |
| Packaged | 3.149 s | 53.258 MiB | 33.027 MiB | 3.5 ms | 0.766 s |

Observed current packaged UI, isolated profile:

- Health endpoint at approximately 3.4 seconds; root frontend requested at
  6.1 seconds and all six adapter chunks requested in the same logged second.
- At 89.8 seconds: eight-process tree (two app processes and six WebView2
  processes), 716.72 MiB working set, 591.73 MiB private, 36.11 CPU seconds.
- Across 10 minutes 30 seconds of visible UI activity: 1,320 metadata proxy
  completions, 1,314 HTTP 200 and six HTTP 502, mean 2.41 completions per
  active second and maximum six in one logged second.
- The isolated window received a real `/api/shutdown` request and exited. This
  profile never contained the user's favorites.

Observed isolated source backend:

- At 4.5 minutes: 46.03 MiB working set and 29.88 MiB private.
- At 18.7 minutes: 46.06 MiB working set and 29.88 MiB private; shutdown in
  0.270 seconds.

Static workload mapping explains the packaged request pressure:

- initial browse, search, and every load-more round use `Promise.allSettled`
  over all six enabled sources;
- auto-chain delay is only 250 ms;
- `view.items` and its ID index are intentionally unbounded;
- DOM begins at 300 cards and grows by 200 without a sliding upper bound;
- artwork has a separate concurrency of six.

Visual-control limitation: the supported in-app Browser reported no available
browser backend and the supported Windows control pipe was absent. Therefore
first-card DOM timing, exact DOM card count, scroll-frame p95, and interactive
search latency remain explicitly `null` in the machine-readable harness. Code
constants and prior user screenshots are context, not fabricated live DOM
measurements. The supported connections will be retried at the next real UI
gate.

The benchmark self-audit also tightened isolation: both
`WORLDMEDIA_STATE_ROOT` and `WORLDMEDIA_PORTABLE_ROOT` point inside the same
temporary test directory, and process-tree cleanup now completes before log
reading or temporary-directory removal. A source/packaged `1,2` second repeat
passed with authenticated clean shutdown and left no `worldmedia-phase0-*`
directory or World Media test process behind.

### Selected Phase 1/2 ceilings

These are initial bounded values, subject only to measured Phase 10 tuning:

| Resource | Ceiling | Evidence/rationale |
|---|---:|---|
| Global catalog operations | 4 active | Current six-way rounds and six-completion burst; research gate requires old-source responsiveness with eleven sources |
| Per-provider catalog operations | 2 active; LOC 1 | Prevents one source from occupying all slots; LOC keeps its stricter 10/minute bucket |
| Dynamic feed/origin resolves | 4 global, 2 per host | Matches the research gate while bounding federated fan-out |
| Prefetch ahead of viewport | low 330 / high 660 items | One/two 30-item pages across eleven sources; enough fairness without a firehose |
| Resident catalog items | 6,000 plus protected favorites/current/detail | About eighteen fair eleven-source page rounds; replaces the measured unbounded growth while retaining deep discovery |
| Mounted DOM cards | 300 maximum sliding window | Preserves the existing initial visual budget but removes its unbounded +200 growth |
| Shared metadata cache | 256 entries and 64 MiB, whichever is first; 64 entries/provider | Holds more pages than the resident pool while remaining memory bounded |
| Disk artwork cache | 512 entries and 256 MiB, whichever is first | Prevents unbounded thumbnail retention while allowing visible/prefetch reuse |
| 15-minute packaged target | below 900 MiB working set and 750 MiB private | Practical headroom above the 89.8-second 716.72/591.73 MiB baseline; Phase 10 must prove it plateaus |

### Phase 0 direct-code audit

Completed after smoke testing, independently from the test assertions:

- Re-opened the contract, manifest, all fourteen provider payload fixtures,
  both fixture test suites, the dependency freeze probe, and both halves of the
  benchmark harness. The manifest covers every file exactly once; exact-byte
  hashes pass; the sole loopback URL and DTD/entity markers are confined to the
  explicitly declared hostile XML fixture.
- Mapped registry/lazy loader (`sources.js`), normalized item and cursor shape
  (`item-model.js`, `search.js`), progress/status lifecycle (`chain.js`,
  `progress.js`, `render.js`), source switches and rows (`sidebar.js`), About,
  settings, favorites/EQ storage, player/capture resolvers, secure connector,
  control routes, and both portable-folder/one-file build inputs. Every later
  integration point has a frozen fixture or an explicit Phase 1-11 gate.
- Confirmed `SOURCES` and the packaged frontend still contain exactly the
  original six adapters and exactly one lazy JavaScript chunk per adapter. None
  of the five planned IDs is registered or bundled.
- Confirmed settings migration retains unknown/future fields and disabled
  source flags; favorite normalization/metadata refresh retains unknown item
  fields and updates the existing saved object in place. The keys remain
  `worldmedia.favorites.v1` and `worldmedia.eq.v1`. Source disablement or future
  filtering has no path to Clear Data; only the separately confirmed Settings
  button can call it.
- Read-only inspection found the user's favorites key in the normal WebView2
  profile. Every native audit launch used disposable state and portable roots;
  none opened or mutated the normal profile.
- The only audit repair outside Phase 0 fixtures/docs/harnesses was a test-only
  shutdown-race fix in `test_control_api.py`: an Event now keeps the scheduler
  mock active until the server thread invokes it. Five repeated control-API
  runs passed, followed by the full Python suite. Production shutdown code was
  not changed.
- Production behavior and registration are unchanged. `.gitattributes` only
  pins the new fixture corpus to LF; all other Phase 0-owned changes are tests,
  fixtures, the opt-in benchmark, and documentation.

### Phase 0 exit gate

| Gate | Result | Evidence |
|---|---:|---|
| JavaScript regression | 94/94 passed | `npm test`, 3.78 seconds |
| Python regression | 103/103 passed | discovery suite, 54.14 seconds |
| Frontend production build | Passed | Vite 8.1.4, 61 modules, 0.98-second build; only recorded pre-existing warnings |
| Python compile | Passed | 42 production/build/test modules |
| Fixture focused smoke | Passed | JavaScript 5/5; Python 5/5 |
| Harness repeat | Passed | isolated source and packaged modes, clean authenticated shutdown, no residue |
| Diff check | Passed | `git diff --check`; line-ending conversion warnings only |
| Production behavior | Unchanged | no source registered, no production runtime source edited by Phase 0 |

Recent pre-mission manual evidence covers old radio, IPTV playback/recording,
archive playback/download behavior, favorites, EQ, Library tab return, and
Shutdown. Phase 0 did not fabricate a second visual run while both supported
control connections were unavailable; that explicit evidence limitation is
carried to the Phase 8/10 UI gates.

## Phase 1 - Shared scheduler, cursors, snapshots, and bounded residency

Status: complete.

### Implementation and contracts

- Added `src/lib/catalog-scheduler.js`: global concurrency 4, per-source
  concurrency 2, priority lanes, round-robin source fairness, stable-key
  deduplication, a 256-job queue ceiling, source cancellation, bounded
  cooldown/`Retry-After`, visibility pause for background work, and injectable
  clock/timer/microtask seams. An active slot is retained until its task really
  acknowledges abort and exits.
- Routed Library initial pages, prefetch/load-more, manual retry, partial text
  search, and optional live snapshots through the scheduler. The exported
  `searchAll` fan-out plus Discovery, Grid, and Tuner now use the same boundary;
  the old unconditional 19 MiB IPTV startup preload was removed.
- Added generation-owned `AbortController` lifecycles to Library, Discovery,
  Grid, and Tuner. A global settings subscription cancels a disabled source;
  every mode teardown invalidates its generation and removes subscriptions or
  global dial listeners before detached completions can render.
- Added a deterministic 5-second per-provider Discovery attempt deadline inside
  the 20-second overall race. This lets later providers receive a scheduler
  slot when four earlier providers are slow. Empty-but-valid results reject
  only outside the scheduler, so they do not falsely penalize a healthy source.
- Replaced array-length exhaustion guesses with explicit adapter
  `browsePage()` contracts. A non-exhausted null/unchanged cursor is a retryable
  error. Only `exhausted:true` retires a finite cursor.
- Extended strict HTTP operations with separate `getJson`, `getText`, and
  `postJson`, typed status/content/parse/GraphQL/oversize errors, decoded-body
  budgets, bounded `Retry-After` and exponential waits, response-body cancel,
  timeout ownership, and abort-safe listener/timer cleanup.
- Added `catalog-store.js` and `snapshots.js`: in-place duplicate refresh,
  atomic per-source snapshot replacement, live/stale/retrying/disabled state,
  last-known-good ownership, refresh cadence preservation, and offline
  tombstones for pinned identities. Snapshot lifetime is independent from
  finite browse/search generations and is canceled only by source disable,
  mode pause, or explicit caller cancellation.
- At this checkpoint, enforced measured low/high prefetch watermarks of 330/660, a 6,000-item
  resident ceiling, a 300-card sliding DOM window, and eviction of only oldest
  unseen items that are not favorites/current/detail/snapshot/query pins.
  Source/type/index counts remain resident-consistent; session totals remain
  intentionally cumulative. Per-item query history is capped at the 16 most
  recent tags.
- Added normalized `content_rating` values `explicit`, `not-explicit`, and
  `unrated`; old items without the field normalize to `unrated`.

### Focused verification

Final command:

```powershell
node --test tests\discovery-attempt.test.js tests\catalog-scheduler.test.js tests\snapshots.test.js tests\library-orchestration.test.js tests\catalog-store.test.js tests\http.test.js tests\item-rating.test.js
```

Result: 29/29 passed. Covered global/per-source concurrency, fairness,
deduplication, priority, queued/active/disabled/visibility cancellation,
fake-time cooldowns, bounded source membership, Discovery timeout/parent abort,
strict response types and budgets, malformed/CAPTCHA/GraphQL/429/timeout paths,
snapshot add/update/remove/stale/recover/unsupported/pause-first-attempt paths,
offline favorite pins, resident/index/count invariants, and production wiring.

### Isolated production-UI smoke

A real headless Microsoft Edge loaded the exact hashed Vite production bundle
`/assets/index-DP75n7dK.js` from `tests_python/phase1_ui_harness.py`. The Edge
profile, backend state, and portable root were unique
`%TEMP%\worldmedia-phase1-ui-*` directories. The harness seeded exactly two
synthetic sentinel favorites; it never read the normal World Media profile.

All 12 checks passed:

1. scheduled initial load;
2. initial DOM ceiling;
3. visibility pause/resume;
4. browse 429 retry without false exhaustion;
5. long-scroll sliding window;
6. rapid-search debounce with partial render;
7. text-search rate-limit retry;
8. tab cancellation and resumed pending query;
9. sidebar restoration;
10. disable/re-enable with delayed in-flight stale-completion rejection;
11. favorite identity/order/custom-field preservation; and
12. no unhandled browser errors.

Final fixture stats were 41 station calls, zero active calls, maximum one
fixture call active, zero pending injected failures/delays, and the expected
`gamma`, three `rate-search`, and `return-after-tab` queries. Favorite count
remained two. Safe process/profile cleanup left zero matching temp directories.

### Full repeat regression

| Gate | Result | Evidence |
|---|---:|---|
| JavaScript | 123/123 passed | `npm test`, 9.42 seconds |
| Python | 103/103 passed | discovery suite, 48.275 seconds |
| Frontend build | Passed | Vite 8.1.4, 65 modules, 1.23 seconds; only the recorded dash.js/CommonJS and chunk-size warnings |
| Python compile | Passed | all 44 Python files |
| Diff check | Passed | `git diff --check`; line-ending conversion warnings only |
| Real production UI | 12/12 passed | exact hashed bundle, isolated Edge state, zero residue |

### Independent post-smoke direct-code audit and repair loop

The audit reopened the scheduler, HTTP helper, all Library orchestration/store/
snapshot/render/state paths, search wrappers, main settings bridge, Discovery,
Grid, Tuner, the six adapters' abort/page connections, and persistence
boundaries. It traced every input through queue acquisition, adapter load,
transport, normalization, page/snapshot merge, indexes/counts, render windows,
mode/source disable, retry, and teardown.

Findings repaired before the final repeat smoke:

- kept each source only once in the scheduler's round-robin ring across repeated
  empty/recreated queue lifecycles;
- canceled failed HTTP bodies and capped exponential fallback waits;
- removed short-array false exhaustion and rejected nonadvancing cursors;
- made Retry Now rerun the active text query rather than hidden browse work;
- preserved snapshot status through finite/search status restoration;
- retained pinned offline snapshot ownership until a later unpinned refresh can
  remove it, without clearing its offline tombstone accidentally;
- used the Favorites pool length for render-window expansion beyond 300 items;
- stopped finite pagination from rediscovering/refetching the same snapshot;
- capped per-item query tags and preserved exact snapshot refresh due time
  through pause/resume;
- resumed a first snapshot attempt paused while adapter capability was still
  being discovered;
- reconnected a pending debounced query after Library tab return;
- removed the scheduler-bypassing IPTV prewarm and routed every interactive
  catalog mode plus the generic fan-out through the shared queue;
- added mode-change cancellation and stale-generation guards to Grid/Tuner;
- separated snapshot lifetime from browse/search generation cancellation;
- prevented healthy empty Discovery responses from causing cooldown, while a
  per-provider deadline prevents four slow sources from starving later ones;
- made current-mode Grid/Tuner cancellation settle the loading UI instead of
  leaving a permanent spinner.

The repaired areas were reopened after the final smoke. Slot counters decrement
only in `_finish`; queued cancellation removes its job/listener immediately;
active cancellation retains its slot until task exit; cooldown/visibility wake
timers are singular and cleared; generation/source checks precede every UI/store
mutation; finite and snapshot ownership sets are separate; offline pins are
reconsidered; render and resident bounds are deterministic; all global/local
listeners and timers have paired cleanup.

No Phase 1 module adds a dynamic URL gateway, persists an ephemeral token, calls
Clear Data, or writes favorites. The only favorite mutations remain the user's
existing card/detail Favorite controls. The isolated sentinel proved that
normalization retains future/custom fields and order. `SOURCES` and the built
adapter chunks still contain exactly the original six IDs; none of the five new
providers is registered.

### Phase 1 exit gate

Complete. Existing six-source behavior is regression-clean, concurrency/memory/
status contracts are bounded and deterministic, the direct-code audit repair
loop is closed, and normal saved favorites were never opened or modified.

## Phase 2 - Secure catalog gateway, cache, parsers, and asset relay

Status: complete on 2026-07-15. Phase 3 is next.

### Production result

- Added `worldmedia_catalog.py` as the only backend boundary for arbitrary
  podcast feeds, exact-origin PeerTube detail resolution, the two fixed
  Owncast directory endpoints, and dynamic artwork.
- Added authenticated fixed control routes in `worldmedia_server.py` and the
  matching fixed-route browser client in `src/lib/catalog-client.js`. Dynamic
  provider URLs never enter `/api/proxy`.
- Added versioned `catalog-v1` and `assets-v1` stores under the native cache
  root. Both are atomic, checksummed, TTL/LRU bounded, corruption-tolerant,
  narrowly clearable, and optional: a full/unwritable cache disk now degrades
  to valid uncached results instead of preventing app startup or discovery.
- Added safe RSS 2.0, Atom 1.0, and Podcasting 2.0 normalization with
  `defusedxml`, independent XML/tree/emission limits, bounded text, explicit
  state, live state, enclosures, dates, language, artwork, and license inputs.
- Added strict PeerTube public/published/rating/identity validation and
  normalized HLS, MP4 playback, and eligible download choices.
- Added a bounded quoted/multiline M3U state machine for Owncast and an exact
  origin join to directory JSON whose `nsfw` field must be a real boolean.
  Missing/conflicting ratings fail closed and suspicious empty refreshes use
  last-known-good data.
- Added opaque, scoped, random artwork IDs; DNS is checked at registration and
  again at fetch. The relay validates MIME, magic, structure, byte size,
  dimensions, and pixels for JPEG/PNG/GIF/WebP and implements bounded
  concurrency, ETag, Range/If-Range, expiration, coalescing, and shutdown.
- Pinned `defusedxml==0.7.1` in build inputs, PyInstaller collection, and both
  copies of the third-party notices. The notice SHA-256 values match:
  `30272A36F16E16E7FAF8118F6C1733628E03A5C769845D47EAE061B3BCA56717`.
- Kept `src/lib/sources.js` at exactly the original six sources. None of the
  five planned adapters is registered in production yet.

### Focused and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Catalog/route/security/download focus | Passed | 27 focused tests after cache/schema repairs; 25 focused lifecycle/catalog tests after the final shutdown repair |
| Download race stress | Passed | The two cleanup/duplicate tests passed 20 consecutive repetitions after reproducing the original race on repetition 11 |
| JavaScript regression | 126/126 passed | Final `npm test` |
| Python regression | 125/125 passed | Final `python -m unittest discover -s tests_python -p "test_*.py"`, 47.447 seconds |
| Frontend production build | Passed | Vite transformed 65 modules; only the existing dash.js/CommonJS and chunk-size warnings |
| Phase-owned Ruff and Python compile | Passed | Catalog, server, connector, security, download, route, fixture, and packaging-probe files |
| Diff hygiene | Passed | `git diff --check`; only existing Windows line-ending conversion notices |
| Source-mode gateway probe | Passed | Feed title `Fixture RSS Show`, PeerTube UUID match, five Owncast items, exact PNG hash, `defusedxml 0.7.1` |
| Fresh one-file gateway probe | Passed | 9,701,097-byte EXE built 2026-07-15 01:46:28 -07:00 and exercised all four localhost control/upstream paths |
| Persisted-data scan | Passed | No control token, auth/cookie marker, local path, private address, or malicious XML marker in isolated source/one-file state roots |

The one-file warning report contains only expected platform/optional imports;
the executable itself imported and exercised `worldmedia_catalog` and
`defusedxml`. Repository-wide Ruff was also sampled: it reports 47 existing
style findings in older opt-in harnesses and unrelated modules; no Phase 2
owned file is among those findings, so this non-gate did not mask a Phase 2
failure.

### Independent direct-code audit and repair loop

The audit reopened and mapped each path rather than inferring correctness from
green tests:

1. Request target -> exact route/method -> Host/Origin/session token -> JSON
   type/length/schema -> service operation and structured `Retry-After` error.
2. Dynamic URL -> canonicalization -> DNS/global-address policy -> pinned
   `SafeConnector` -> redirect revalidation -> exact-origin/fixed-URL policy ->
   compressed/decoded byte and elapsed-time caps.
3. Bytes -> strict JSON/defused XML/M3U parser -> bounded normalized value ->
   sensitive-persistence scan -> checksummed atomic cache -> response.
4. Artwork URL -> scoped opaque registration -> second DNS validation ->
   coalesced bounded fetch -> MIME/magic/structure/dimension validation ->
   binary cache -> nosniff relay/Range response -> scoped expiration.
5. Clear/shutdown -> epoch invalidation -> cancellation -> bounded active-read
   drain -> exact recognized cache files only. Browser profile data is outside
   both cache roots.

Defects found and repaired during these independent passes:

- stripped conditional validators on cross-origin redirects and reduced
  outbound headers to an exact safe allowlist;
- added value checksums, validator sanitization, sensitive URL/header/local
  data rejection, disk-full uncached fallback, descriptor cleanup, and startup
  LRU/orphan pruning;
- removed unsupported AVIF advertising, verified cached asset ETags, tightened
  PNG structure/CRC checks, bounded Range length, and implemented If-Range;
- redacted opaque asset IDs from request logs;
- rejected Python boolean values masquerading as PeerTube integer privacy/state
  IDs;
- handled escaped quotes/comments and global candidate limits in Owncast M3U,
  plus last-known-good fallback for a suspicious empty refresh;
- repaired an existing download lifecycle race exposed by the exhaustive run:
  terminal status now follows private-file cleanup/source release, immediate
  retries no longer see a stale duplicate, and direct service shutdown leaves
  no active job. The race and leftover `.part` file were reproduced before the
  repair, then covered deterministically and stress-tested.

### Favorites preservation and environment note

- Every source, socket, packaging, and one-file run used disposable state and
  portable roots on `E:`. The normal WebView profile was never opened,
  migrated, cleared, or used for tests.
- Catalog and asset clear tests place favorite sentinels in sibling
  `webview2_data` paths and prove those bytes survive. Cache clearing recognizes
  only hashed/versioned cache filenames below `catalog-v1`/`assets-v1`.
- The normal Settings clear behavior was not changed; the new native catalog
  clear is separate and is not wired to that UI in this phase.
- `C:` became effectively full during the phase (initially zero free bytes,
  about 2.6 MB free at the final check). No user files were deleted. Temporary
  and PyInstaller work were redirected to `E:`, and the new optional-cache
  startup behavior was specifically tested under simulated disk exhaustion.

### Phase 2 exit gate

Complete. Security/package/regression gates pass, catalogs and assets have one
auditable boundary, the post-smoke direct-code audit repair loop is closed,
the five sources remain unregistered, and saved favorites were not touched.

## Phase 3 - media.ccc.de / C3VOC adapter

Status: complete on 2026-07-15. Phase 4 is next.

### Production result

- Added the unregistered `src/adapters/media-ccc.js` adapter with bounded,
  cancellable provider scheduling and standard browse/search/random,
  lazy-resolution, artwork, and live-snapshot exports.
- Recent VOD uses validated RFC Link relations, cached 100-event upstream
  pages, transactional 30-item cursors, bounded session deduplication, and
  explicit exhaustion. Fixed, parameterized GraphQL supplies search results.
- Event resolution chooses one original-language MP4 or an MP3 fallback and
  couples finite playback/download fields to the same official recording and
  filename. Descriptions, tags, identities, links, licenses, and collections
  are normalized within explicit processing bounds.
- C3VOC v2 data is an independent TTL snapshot with stable room identities,
  native HLS preference, native-audio radio fallback, translation/slides
  suppression, honest valid-empty behavior, and generic stale recovery.
- Dynamic posters use the opaque asset relay. Favorite normalization removes
  session-only relay IDs while retaining canonical `_extra.artworkUrl` data so
  a future session can hydrate a fresh relay URL.
- Extended the metadata proxy with narrowly sanitized Link/Retry-After
  forwarding. No cookie or arbitrary response-header surface was added.
- Kept `src/lib/sources.js` and the production build at the original six
  sources. Registration remains intentionally deferred to Phase 8.

### Focused, live, and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final focused adapter/integration suite | 35/35 passed | CCC fixtures, HTTP metadata, thumbnails, catalog merge, and snapshot manager |
| JavaScript regression before build | 147/147 passed | `npm test` |
| Frontend production build | Passed | Vite transformed 65 modules; only original six adapter chunks emitted |
| JavaScript regression after build | 147/147 passed | Sequential post-build `npm test` |
| Native/backend regression | 125/125 passed | Isolated `WORLDMEDIA_STATE_ROOT` on `E:`, 48.477 seconds |
| Polite official probes | Passed | Recent 100-item page/Link, GraphQL search, event detail, current valid-empty live v2, cached random |
| Ranged VOD relay | Passed | Official MP4 returned 206, exact 65,536-byte range, valid `ftyp` signature |
| Local capture/playback integration | 3/3 passed | MP3 profiles, H.264/AAC HLS profiles without upscale, recoverable interrupted fragmented MP4 |
| Syntax/diff hygiene | Passed | Node checks and `git diff --check`; Windows line-ending notices only |

The official live endpoint was validly empty between events. The sanitized
published nonempty v2 fixture therefore supplied deterministic nonempty live
coverage, while the official endpoint proved the separate valid-empty path.

### Independent direct-code audit and repair loop

After the first exhaustive smoke pass, production code was reopened and
mapped through browse -> cursor -> item -> lazy detail -> media registration ->
capability, and live snapshot -> merge -> artwork -> favorite -> cancellation.
The audit found and repaired issues that green adapter-only tests had missed:

- accepted only the exact local opaque asset-relay path in the thumbnail UI,
  while continuing to reject arbitrary relative/data URLs;
- preserved a hydrated relay thumbnail across a snapshot only when its
  canonical artwork identity is unchanged, and made artwork-check state
  sensitive to later canonical changes;
- made browse-page deduplication transactional so a failed bridge request
  cannot consume items the caller never received;
- prevented non-cursor Grid/Tuner browse calls from allocating sessions and
  evicting an active Library cursor;
- isolated cache entries by AbortSignal so a cancelled search generation
  cannot poison an immediate identical replacement;
- bounded nested tags, recordings, GraphQL results, conferences, groups,
  rooms, streams, and per-stream URL maps;
- rejected provider-declared premature pagination completion when `last`
  proves a `next` relation is missing;
- ranked native audio ahead of translated video, while retaining translated
  video only when it is the sole usable room rendition.

Focused tests were expanded for every repair and rerun. The entire JavaScript
suite, production build, post-build JavaScript suite, and entire native suite
then passed. A final independent re-open confirmed generic scheduler failure
paths retain cursors, snapshot failures retain last-known-good items, lazy
playback always registers an opaque media relay, temporary artwork IDs are not
persisted, and teardown aborts pending catalog/snapshot work.

### Favorites preservation

- Every local server/native test used a disposable state root on `E:`. The
  normal WebView profile was not launched, migrated, cleared, or used.
- No new source is registered, so this phase cannot rewrite normal settings or
  favorites through source-list migration.
- The only favorite-specific production change is additive normalization for
  temporary artwork relay IDs; unknown/future favorite fields and canonical
  source metadata are retained and tested.

### Phase 3 exit gate

Complete. The media.ccc.de/C3VOC contract passes fixture, official live,
relay, regression, build, and independent post-smoke audit gates. The adapter
remains unregistered and normal saved favorites were untouched.

## Phase 4 - Library of Congress adapter

Status: complete on 2026-07-15. Phase 5 is next.

### Production result

- Added the unregistered `src/adapters/library-of-congress.js` adapter for the
  official LOC audio and film/video JSON formats. Alternating independent
  cursor lanes prevent either format from starving or falsely exhausting the
  other, and search retains valid partial results when one lane fails.
- Every LOC JSON path shares one cancellable burst-1 gate with a six-second
  minimum start interval. `429` and CAPTCHA/HTML impose a one-hour cooldown;
  provider/schema/zero-result failures remain distinct from real exhaustion.
- Catalog requests use 30 results and minimum `at=results,pagination` fields.
  Pages, totals, bounds, next links, canonical identities, and the 100,000-item
  deep-page boundary are validated before cursors advance.
- Item details remain lazy. Bounded traversal covers public `audio`,
  `video_stream`, file, stream, and derivative shapes, chooses adaptive
  playback where appropriate, and exposes a finite download only when the
  applicable access, download, `canDownload`, and rights signals all permit it.
- Dynamic artwork uses the scoped opaque asset relay; favorite records retain
  only canonical rehydration metadata. Summary/detail caches and a bounded
  eligible reservoir prevent request-per-card and request-per-random behavior.
- Added a generic `downloadResolved` capability contract so the shared legacy
  finite-file repair cannot recreate a download that a rights-aware adapter
  deliberately suppressed. Existing adapters and legacy favorites retain
  their prior inference behavior.
- Kept the source out of `src/lib/sources.js`; registration remains deferred to
  the migration-protected Phase 8 gate.

### Focused, live, and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final focused LOC/capability suite | 31/31 passed | Cursor, search, gate, cooldown, schemas, resources, rights, favorites, and generic capability regressions |
| JavaScript regression before build | 173/173 passed | `npm test` after audit repairs |
| Frontend production build | Passed | Vite transformed 65 modules; only the original six adapter chunks were emitted |
| JavaScript regression after build | 173/173 passed | Sequential post-build `npm test` |
| Native/backend regression | 125/125 passed | Disposable `WORLDMEDIA_STATE_ROOT` and portable root on `E:`, 47.841 seconds |
| Polite official app-proxy smoke | Passed | Four gated LOC metadata calls resolved 27 audio and 29 video summaries plus one playable item of each type |
| Syntax/registration/chunk hygiene | Passed | Node syntax checks, scoped diff check, registry assertion, and emitted-chunk assertion |

The official smoke fetched metadata only; it did not download full media.
Calls used the production World Media metadata proxy and the adapter's normal
one-request-per-six-seconds gate. A separate direct curl confirmed LOC was
healthy when a direct Node network path timed out, and the app-proxy run then
completed normally.

### Independent direct-code audit and repair loop

After the first green smoke pass, production code was reopened and mapped
through provider URL -> shared gate -> page validation -> transactional cursor
-> normalized item -> lazy detail -> bounded candidate traversal -> playback /
download capability -> media relay -> favorite normalization -> artwork relay
-> cancellation and disposal. That audit found and repaired issues not exposed
by the initial adapter-only tests:

- made completed rights decisions authoritative across the shared player,
  state/favorite migration, manifest inspection, and capture action resolver;
- separated access restrictions from download-only/streaming-only advisories,
  so restricted downloads stay hidden without incorrectly blocking playback;
- made explicit child or duplicate-resource denials override a parent download
  grant, and included item/resource/file rights text in the conservative gate;
- rejected fabricated bare-filename media URLs, hostile/lookalike hosts,
  fragments, credentials, sensitive query fields, and nonstandard ports;
- sanitized human-readable download names and bounded resource collections,
  nesting, candidate counts, rights text, caches, and reservoirs;
- accepted a valid detail URL when a heterogeneous noncanonical `item.id` is
  also present, while still rejecting identity changes;
- allowed legitimate pages containing only onsite-restricted summaries to
  advance instead of entering an endless retry;
- preserved cursor state on failure, inherited nested file policy, isolated
  aborted cache generations, and enforced a real one-hour cooldown even when a
  `429` says `Retry-After: 0`.

The repair loop added focused assertions for every item above, reran the focused
suite, reran all JavaScript tests, rebuilt production, reran all JavaScript
tests, and ran the complete native/backend suite. A final re-open confirmed the
rate gate owns all LOC JSON requests, HTTP helpers perform zero hidden retries,
the metadata proxy performs no retry amplification, disposal clears queued
timers/jobs, and all remaining active I/O is externally cancellable or bounded
by network timeout.

### Favorites preservation

- Every server/native run used disposable roots below `E:\WorldMediaWindows\build`.
  The normal WebView profile was never opened, migrated, cleared, or used.
- LOC remains unregistered, so normal source settings and saved favorites
  cannot be rewritten by this phase.
- Tests prove a restricted resolved item remains non-downloadable after favorite
  normalization and that opaque artwork tokens are removed while canonical
  artwork metadata and unknown/future fields survive.

### Phase 4 exit gate

Complete. The LOC adapter is rate-safe, rights-safe, retry-safe, fixture/live
smoke tested, independently audited, and still absent from production
registration. Normal saved favorites were untouched.

## Phase 5 - gPodder podcast adapter

Status: complete on 2026-07-15. Phase 6 is next.

### Production result

- Added the still-unregistered `src/adapters/gpodder.js` adapter. It uses only
  gPodder's fixed toplist/search endpoints for bounded show discovery and sends
  publisher feeds through the Phase 2 native feed resolver; it never sends a
  dynamic publisher URL through the generic frontend HTTP path.
- Browse freezes a maximum-100-show snapshot and transactionally tracks feed
  index, per-feed episode position, attempted/dead state, and snapshot identity.
  Four-feed batches are interleaved so one prolific podcast cannot monopolize a
  page, and short pages remain nonterminal while unattempted work exists.
- Directory traffic has a burst-2/refill-one-per-second gate. Feed work is
  cancellable and capped at global four/per-host one. Feed, snapshot, search,
  and random reservoirs are bounded; adapter disposal aborts work and clears
  all queues, timers, caches, cursors, buffers, snapshots, and reservoirs.
- The defended RSS/Atom/Podcasting 2.0 parser now normalizes compatible MP3,
  H.264 MP4, and HLS enclosures, alternate enclosures, license inheritance,
  explicit markers, artwork, and live status. Only `status=live` records become
  live media, and a current live record cannot be crowded out by a 1,000-item
  episode archive.
- Finite episodes expose on-demand playback and Download; current live audio or
  video exposes Record. Backend SHA-256 identities and canonical redirect
  aliases keep favorite/EQ keys stable without persisting raw GUIDs, opaque
  relay tokens, credentials, or signed query URLs.
- Publisher failures are isolated by feed with bounded cooldown and
  last-known-good fallback. Search remains useful with partial failures, and
  `random()` samples only already-validated eligible cached items without
  starting discovery traffic.
- The adapter honors the explicit-content preference supplied by its caller,
  defaults it off, and resets standalone browse buffers when that preference
  changes. It is not registered until the migration-protected Phase 8 gate.

### Focused, live, and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final focused gPodder suite | 28/28 passed | Directory/feed gates, cursors, generation races, parser bridge, capabilities, favorites, assets, explicit filtering, and teardown |
| Combined focused JavaScript suite | 33/33 passed | gPodder plus shared media-capability contracts |
| Focused catalog/control/fixture suite | 13/13 passed | Feed parsing, security, redirect identities, conditional cache, and current-live priority |
| Local download/record integration | Passed | Exact-byte finite episode download plus valid FFmpeg MP3 and MP4 live recordings |
| Official metadata-only live smoke | Passed with isolated publisher failures | `science` search returned 20 directory entries; four feeds were capped at global 4/per-host 1; one produced 1,000 episode records and three independently reported upstream/status/connect/XML-complexity failures; no episode media was downloaded |
| Final JavaScript regression before build | 201/201 passed | `npm test` with disposable state |
| Final native/backend regression | 128/128 passed | Python unittest discovery in 56.017 seconds with disposable state |
| Frontend production build | Passed | Only the original six adapter chunks were emitted; gPodder remains unregistered |
| Final JavaScript regression after build | 201/201 passed | Sequential post-build `npm test` |
| Syntax/registration/diff hygiene | Passed | Node/Python compile checks, pre-Phase-8 registry and chunk assertions, and `git diff --check` |

Final regression logs and state are under
`build/phase5-final-regression-retry-20260715-055025`; the normal application
profile was not opened by the run.

### Independent direct-code audit and repair loop

After focused and full smoke tests, production code was reopened and mapped
through fixed directory request -> directory gate -> bounded show snapshot ->
feed scheduler -> native SSRF/XML boundary -> enclosure normalization -> stable
identity -> transactional browse/search cursor -> item capability -> opaque
asset/media relay -> favorite normalization -> cooldown/LKG -> cancellation and
disposal. The independent audit found and repaired issues beyond the original
happy-path tests:

- prevented a missing initial toplist load from dereferencing `null`, and made
  superseded toplist/search/feed generations unable to replace newer cache
  state, mark a newer snapshot stale, or seed the random reservoir;
- retained an older validated feed as last-known-good when a newer queued
  refresh fails, while preventing an older late success from overwriting a
  newer successful value;
- preserved feed identity through HTTP redirects, 304 revalidation, stale
  fallback, and later redirect moves; mandatory requested/resolved/stable aliases
  cannot be crowded out by bounded redirect history;
- made GUID handling exact and opaque for identity, removed raw GUIDs from
  favorite-persisted metadata, stripped control/bidirectional characters, and
  decoded safe display entities without changing the identity input;
- rejected incompatible or misleading enclosure MIME/extension/codec pairs,
  torrent/OGG/AAC/WebM paths, credentials, nonstandard ports, and sensitive or
  signed query parameters, while correctly accepting generic HLS with declared
  H.264 video codecs;
- bounded snapshots, feed prefixes, page attempts, directory/search caches,
  aliases, nested collections, and the random reservoir; fixed short-limit
  browse buffering so records are not dropped or endlessly refetched;
- made explicit-preference transitions discard incompatible buffered pages,
  kept current live entries ahead of long archives, and excluded pending/ended
  schedule entries from playable results;
- kept empty/malformed directory payloads distinct from truthful exhaustion,
  honored Retry-After seconds and native nonretryable status cooldowns, and
  ensured one dead or malicious feed cannot complete or fail the whole source;
- verified artwork uses only an opaque local relay URL at render time while
  favorites retain canonical artwork metadata and unknown future fields; and
- verified abort/dispose ownership for directory tokens, feed slots, queued
  timers, in-flight resolver work, cursors, buffers, search runs, and caches.

Every repair received a focused regression test. The final full regression,
build, post-build regression, syntax/registration assertions, and direct code
reread then passed with no open Phase 5 finding.

### Favorites preservation

- Every native, server, live, download, recording, and full-regression run used
  a unique disposable state root below `E:\WorldMediaWindows\build` on `E:`.
- The normal WebView/application profile was never opened, migrated, cleared,
  or used. No test launched the normal app.
- gPodder is still absent from production registration, so this phase cannot
  rewrite normal source settings or the existing favorites collection.
- Favorite normalization is additive: unknown/future fields and canonical
  artwork/feed aliases survive, while only temporary opaque relay tokens and
  raw GUID material are excluded from persistence.

### Phase 5 exit gate

Complete. gPodder remains useful under partial/dead publisher feeds, rejects
malicious feed content at the native boundary, passes deterministic and live
smoke evidence, is independently audited, and remains absent from production
registration. Normal saved favorites were untouched.

## Phase 6 - PeerTube adapter

Status: complete on 2026-07-15. Phase 7 is next.

### Production result

- Added the still-unregistered `src/adapters/peertube.js` adapter. Its only
  frontend discovery target is the fixed SepiaSearch video endpoint, with
  bounded 30-item pages, recent sort, scheduled-live exclusion, and the
  default-off explicit-content filter. Search uses the same policy.
- Summary normalization requires public privacy, valid UUID/watch identity,
  strict boolean NSFW state and bit flags, publication date, numeric duration,
  bounded text/tags/actors, and safe canonical artwork metadata. Stable IDs are
  normalized origin host plus UUID; duplicate short/long watch forms collapse
  deterministically.
- Current PeerTube `Unknown` enum objects (`id:null`) for language and license
  are accepted narrowly as undeclared metadata. Numeric licenses 1-9 remain
  distinct, ID 9 is always All Rights Reserved, and no license value grants a
  download.
- Dynamic origins cross only the authenticated Phase 2 semantic resolver. The
  native side constructs the exact `/api/v1/videos/{uuid}` route, enforces the
  exact origin and public/published/rating identity again, bounds collections,
  and deterministically chooses HLS, MP4, and an independently authorized
  download file.
- Active live items require a real HLS playlist and become TV/Record. VOD
  prefers HLS, falls back to MP4, and exposes Download only when
  `downloadEnabled` is boolean true and a concrete download URL exists. A live
  or VOD response without compatible media settles to Unavailable rather than
  recording or checking indefinitely.
- Sepia traffic is capped at two concurrent requests with 500 ms minimum
  spacing. Dynamic detail work is capped at global four/per-origin two;
  Retry-After and origin cooldowns are isolated. Index/detail caches,
  last-known-good recovery, generation guards, random reservoir, cancellation,
  and teardown are bounded.
- Thumbnails/previews use only the opaque asset relay. Favorites retain stable
  identity and canonical artwork metadata, discard session-local asset tokens,
  and can resolve after a simulated restart without reloading Sepia.
- The shared capability resolver now waits for an actual live stream URL before
  offering Record. This preserves existing radio/IPTV behavior while making a
  missing PeerTube live rendition settle honestly.

### Focused, live, and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final PeerTube focused suite | 18/18 passed | Index/schema/rating/identity, resolver seam, media rights, caching/races, per-origin scheduling, assets, favorite restart, random, abort, and disposal |
| PeerTube plus shared capability suite | 24/24 passed | Includes unresolved/resolved live action states and all original adapter capability rows |
| Focused native catalog set | 6/6 passed | Detail normalization, deterministic choices, exact-origin routing, and authoritative private-state rejection |
| Local VOD download integration | Passed | PeerTube-labeled finite MP4 preserved exact fixture bytes and normal download cleanup behavior |
| Local live recording/EQ integration | Passed | Real FFmpeg produced valid H.264/AAC MP4s and measured the requested 12 dB EQ preamp difference |
| Official metadata-only live smoke | Passed | Clean 30-item browse, 30-item search, and 30-item live index; first bounded VOD and live candidates both revalidated and resolved to HLS without downloading media |
| Final JavaScript regression before build | 220/220 passed | Disposable state on `E:` |
| Final native/backend regression | 132/132 passed | Disposable state/portable roots on `E:`, 66.368 seconds |
| Frontend production build | Passed | Only the original six adapter chunks were emitted; no pending source chunk leaked |
| Final JavaScript regression after build | 220/220 passed | Sequential post-build `npm test` |
| Syntax/registration/diff hygiene | Passed | Node/Python compile, six-source registry assertion, chunk assertion, and `git diff --check` |

Regression state and logs are under
`build/phase6-full-regression-20260715-0712`; live-smoke state is under
`build/phase6-final-live-20260715-0732`. Neither run opened the normal app.

### Independent direct-code audit and repair loop

After the full smoke and production build, the production paths were reopened
and mapped through fixed Sepia URL -> response bounds/filter -> stable identity
-> index scheduler/cache/cursor -> semantic native route -> exact-origin
`SafeConnector` -> detail normalization -> media/download choice -> capability
-> opaque media/asset relay -> favorite normalization -> cache/cooldown ->
cancellation/disposal. The audit and preceding repair loop found and fixed:

- real current PeerTube origins encode Unknown license and language enums with
  null IDs; these now remain honestly undeclared instead of dropping otherwise
  valid pages, while malformed variants still fail;
- stale public detail could previously survive a new authoritative
  private/unpublished/malformed response; both native and adapter caches now
  use stale data only for retryable failures;
- a resolved explicit item could return early after the setting was switched
  off; it now clears media/download state, becomes a hidden re-resolvable item,
  and is rejected until deliberately re-enabled;
- a declared live item without a resolved stream could prematurely offer
  Record; it now reports Checking before resolution and Unavailable after an
  authoritative no-media response;
- invalid nonempty resolver URLs, coerced nonnumeric duration values, and
  malformed nullable enums now fail closed;
- Retry-After seconds are no longer shadowed by null millisecond metadata;
- an explicit-only random reservoir now performs one bounded safe page load
  instead of returning a false empty result;
- pending artwork work is owned by the adapter lifecycle and is aborted on
  source disposal; unused duplicate summary storage was removed;
- deterministic duplicate, download/rendition, favorite-restart, generation,
  abort, and authoritative-state regressions were added for every repair.

The final reread confirmed no PeerTube origin is passed to `/api/proxy`, no
origin image is assigned directly to a card, no missing media becomes a capture
action, no nonretryable public-state change uses stale media, and all queues,
controllers, caches, buffers, and reservoirs have bounded teardown ownership.

### Favorites preservation

- Every native, live, download, recording, build, and full-regression command
  used disposable roots below `E:\WorldMediaWindows\build`.
- The normal WebView/application profile was never opened, migrated, cleared,
  or used. No normal app process was launched.
- PeerTube is absent from production registration, so Phase 6 cannot rewrite
  source settings or the existing favorites collection.
- Favorite tests use in-memory copies only and prove stable identity/canonical
  artwork survive while opaque session tokens are removed.

### Phase 6 exit gate

Complete. PeerTube discovery and origin resolution are rate-bounded,
content-state/rights safe, fixture/live smoke tested, independently audited,
and still absent from production registration. Normal saved favorites were
untouched.

## Phase 7 - Owncast adapter

Status: complete on 2026-07-15. Phase 8 is next.

### Implementation and contracts

- Added an unregistered `owncast` adapter backed only by the fixed native
  Owncast snapshot route. It never sends directory or instance hosts through
  the generic proxy.
- Stable identities are SHA-256 hashes of normalized instance base URLs.
  Playlist URLs are accepted only as public HTTP(S), same-origin HLS endpoints
  and are exposed as live TV with record-video capability through the opaque
  media relay.
- Owncast's verified `nsfw` boolean is preserved as `content_rating`. Explicit
  entries are excluded by default and gain a visible Explicit marker only when
  a caller deliberately requests them.
- Search and random selection use a bounded cached snapshot. A two-minute
  snapshot manager, forced manual retry, monotonic freshness, stale retry,
  last-known-good recovery, pause/resume, and teardown now share one lifecycle.
- Live favorites persist only stable source identity and canonical artwork.
  Transient playlist query strings and session-local asset URLs are removed;
  offline selections revalidate against the current snapshot before playback.
- The native gateway accepts current Owncast `text/plain` JSON and tag-object
  formats while retaining strict object/schema validation. It bounds the
  directory to 5,000 rows and rejects local/private literal targets.

### Focused, live, and exhaustive smoke evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final Owncast focused suite | 15/15 passed | Snapshot changes, stable IDs, ratings, same-origin safety, search/random, zero/offline state, abort/dispose, 5,000-row bound |
| Final JavaScript regression | 236/236 passed | Full sequential `npm test` with disposable state on `E:` |
| Final native/backend regression | 132/132 passed | Full Python suite in 79.314 seconds using disposable roots |
| Frontend production build | Passed | Only the original six registered adapter chunks were emitted; no Owncast chunk leaked |
| Frontend live directory smoke | Passed | Current directory: 61 total, 52 safe, 9 explicit; two preference views shared one native fetch |
| Live play/record smoke | Passed | Relayed HLS decoded as H.264/AAC 1920x1080; compact recording was valid H.264/AAC MP4 at 852x480 |
| Failure and cleanup smoke | Passed | Unreachable `.invalid` stream failed cleanly; snapshot remained usable and catalog/relay/recorder exited with zero workers |
| Syntax/diff hygiene | Passed | Node/Python compile and `git diff --check` |

Final frontend live state is under
`build/phase7-final-frontend-live-20260715-0835`; final relay/record state is
under `build/phase7-final-record-live-20260715-0836`.

### Independent direct-code audit and repair loop

After the full smoke and build, production paths were reopened and mapped from
fixed directory fetch -> native schema/safety join -> snapshot ownership ->
rating predicate -> stable item/asset -> media relay -> record/favorite ->
offline resolution -> pause/dispose/shutdown. The independent audit found and
repaired:

- native stale snapshots were initially published as live; stale metadata now
  reaches the UI and uses the shorter retry path;
- search-first sessions did not enroll snapshot sources in the refresh manager;
- pause/resume could replace an urgent stale retry with a normal two-minute
  interval;
- one unsafe optional logo could discard an otherwise safe stream;
- Explicit could fall off a full tag list, and repeated local views needlessly
  rehashed the whole snapshot;
- a live playlist query could persist in a favorite, and a verified favorite
  could redundantly refetch the same current snapshot;
- current Owncast tag objects and `text/plain` JSON responses were not accepted;
- oversized sections were discarded instead of safely truncated;
- sensitive artwork query keys, mapped/private IPv6 literals, an already-aborted
  waiter, and system-clock freshness shifts needed stricter handling.

Repairs were followed by focused tests, the complete 236-test JavaScript suite,
the complete 132-test backend suite, production build, both live smokes, and a
second direct-code reread. The final mapping confirms bounded queues/caches,
single-owner controllers, forced scheduled refresh, fail-closed schema and
rating behavior, relay-only media, stable favorite recovery, and cleanup of
timers, assets, waiters, workers, and services.

### Favorites preservation

- Every test, native bridge, live smoke, build, playback, and recording command
  used disposable roots below `E:\WorldMediaWindows\build`.
- The normal WebView/application profile was never opened, migrated, cleared,
  or used; no normal app process was launched.
- Owncast remained absent from production registration, so this phase could not
  rewrite source settings or the existing favorites collection.
- Favorite tests operate on isolated in-memory/state copies and verify stable
  identity survives while transient media and asset credentials do not.

### Phase 7 exit gate

Complete. Owncast is snapshot-correct, content-preference-correct,
relay-confined, failure-tolerant, teardown-clean, independently audited, and
still absent from production registration. Normal saved favorites were
untouched.

## Phase 8 - Registration, content setting, and UI integration

Status: complete on 2026-07-15. Phase 9 is next.

### Implementation and contracts

- Registered all five adapters in the single immutable source registry, for
  exactly eleven IDs and eleven lazy production chunks. Settings, About,
  Library, Tuner, Grid, Discovery, and the adapter test page now derive source
  identity, descriptions, rights notes, capabilities, labels, and colors from
  that registry.
- Added one fail-closed content policy with an exact-true, direct-Settings-only
  explicit/NSFW opt-in. Search, browse, random, cards, details, thumbnails,
  Tuner, Grid, Discovery, playback, and capture consume the same policy.
- Replaced IPTV's irreversible initial drop with reversible cached filtering;
  content transitions locally filter cache-capable providers and refresh only
  the providers whose upstream request deliberately excluded marked results.
- Preserved marked favorites as nonrevealing placeholders without changing
  their stable IDs or EQ scopes. Turning the policy off cancels stale catalog
  generations and stops marked playback and capture.
- Added eleven distinct theme colors, independently scrollable source rows,
  accessible status wrapping, responsive detail/player behavior, registry-
  driven counts/filters, and mode-remount preservation.
- Updated both real-Edge production harnesses, fixture/baseline matrices,
  build expectations, README source descriptions, and the production test page
  for the eleven-source build.

### Focused, exhaustive, and production-UI evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final Phase 8 focused integration | 20/20 passed | Registry, migration, policy, IPTV cache, colors/layout, capture identity, detail remount, source orchestration |
| Audit-repair focused repeat | 13/13 passed | Content settings, details, and thumbnail lifecycle |
| Final JavaScript regression | 248/248 passed | Complete `npm test` after the last production-code repair |
| Native/backend regression | 132/132 passed | Complete Python discovery suite using disposable state |
| Frontend production build | Passed | Vite 8.1.4, 72 modules, all eleven adapter chunks; only recorded dash.js/CommonJS and size warnings |
| Catalog production UI harness | 13/13 passed | Exact `/assets/index-BorloYgy.js`, one active request maximum, cancellation/retry/remount, two synthetic favorites preserved |
| Full production UI harness | 17/17 passed | Exact final bundle; five modes, eleven rows/switches, five new-source toggle cycles, explicit toggle, six themes, favorites, audio/HLS, EQ, stop cleanup |
| Syntax/diff hygiene | Passed | Python compile and `git diff --check`; line-ending notices only |

### Independent post-smoke direct-code audit and repair loop

After the full suites and production build, the registry, settings migration,
content predicate, Library scheduler/snapshots/render/detail/artwork paths,
Tuner, Grid, Discovery, player, capture, persistence, mode teardown, and
shutdown subscriptions were reopened and traced from user setting/provider
rating through every visible and background consumer.

The audit found and repaired bounded integration gaps:

- unrelated settings changes could cancel/requeue Library work, and content
  transitions could restart the general auto-chain instead of only the
  rating-aware providers;
- Tuner/Grid partial refreshes could discard unaffected live sources when a
  policy change interrupted an in-flight shared generation;
- capture teardown originally depended too closely on the currently selected
  card instead of the recording job's own content identity;
- Library remount could substitute an unrelated playing item for the selected
  detail, while policy-off handling needed to distinguish hidden favorites
  from nonfavorite details;
- clearing settings while explicit content was enabled did not initially emit
  the same fail-closed teardown transition;
- the hidden-favorite detail path relied only on the thumbnail resolver's
  downstream guard; it now also refuses hydration at the caller;
- the full production UI harness still seeded and asserted six sources, and
  two newly edited mode lines contained trailing whitespace.

Each repair was followed by its affected focused checks, the complete
JavaScript repeat, a fresh production build, both exact-bundle Edge harnesses,
and a second direct trace. No stale hard-coded six-source production list,
unowned controller/timer, duplicate registry metadata path, or content-policy
bypass remains in the audited Phase 8 paths.

### Favorites preservation

- The migration gate used an isolated 58-favorite copy and preserved every ID,
  unknown field, source choice, and EQ association.
- Real-browser harnesses used fresh Edge profiles with exactly two synthetic
  sentinel favorites and disposable state roots below `build`; both retained
  a final count of two.
- The normal World Media/WebView profile was never launched, read, migrated,
  cleared, or written during Phase 8.

### Phase 8 exit gate

Complete. All five sources are registered coherently across the eleven-source
UI, the explicit-content preference is manual, reversible, and fail-closed,
responsive/accessibility contracts pass, and normal saved favorites remain
untouched.

## Phase 9 - Playback, capture, EQ, and favorite rehydration

Status: complete on 2026-07-15. Phase 10 is next.

### Implementation and contracts

- Made all five lazy resolvers settle their delivery, stream kind, media URLs,
  download name, capture headers, license, and resolver/capability state as one
  authoritative update. Invalid, restricted, removed, ended, or offline saved
  identities now settle to a retained unavailable favorite instead of an
  endless Checking state.
- Added restart rehydration for finite C3VOC, LOC, podcast, and PeerTube
  favorites, and fresh snapshot revalidation for live C3VOC, podcast, and
  Owncast favorites. Stable IDs, canonical source links, settings, future
  metadata, and EQ scopes remain intact.
- Made player resolution abortable and generation-owned. A newer item or Stop
  aborts the old resolver, and stale completion cannot publish media or mutate
  the current player.
- Made playback strictly relay-only: every remote URL is validated and
  registered before attachment, and registration failure is fail-closed with
  an actionable retry state rather than a direct cross-origin fallback.
- Kept live playback and recording as separate opaque registrations. Stopping
  or finalizing a recording only addresses its job and cannot expire, replace,
  or stop the player registration.
- Preserved adaptive HLS/DASH playback, finite Range/seeking, selected quality,
  FFmpeg EQ snapshots, progress, stop/cancel/finalize, open-folder behavior,
  and Windows-safe collision-resistant download/recording names.
- Prevented session-scoped media and artwork relay tokens from entering saved
  favorites. Dynamic runtime favorites retain a freshly resolved stream while
  the detached persisted copy stores only restart-safe identity metadata.

### Focused, exhaustive, and production-UI evidence

| Gate | Result | Evidence |
|---|---:|---|
| Final focused player/adapter matrix | 122/122 passed | Five resolvers, capability settlement, cancellation, relay-only playback, restart favorites, and EQ persistence |
| Focused player/capture integration | 77/77 passed | Playback ownership, relay failure, capture UI, direct/HLS/DASH/Range behavior, and old-source compatibility |
| Focused EQ/capture/HLS integration | 31/31 passed | Effective curves, recording snapshot, adaptive playback, audio engine, and lifecycle cleanup |
| Focused native capture additions | 2/2 passed | Five-source finite downloads plus C3VOC/Owncast shared recording boundary |
| Final JavaScript regression | 254/254 passed | Complete `npm test` after the final production changes |
| Native/backend regression | 133/133 passed | Complete Python discovery using disposable roots |
| Media boundary regression | 17/17 passed | Range, HLS, DASH, headers, relay registration, cancellation, and expiry |
| Frontend production build | Passed | Vite production build, 72 modules, all eleven lazy source chunks; only recorded dash.js/CommonJS and chunk-size warnings |
| Full production Edge harness | 17/17 passed | Exact `/assets/index-BJy2a3JT.js`; play/pause, favorites, EQ, all modes, settings, HLS, stop cleanup, and no unhandled browser errors |
| Syntax/diff hygiene | Passed | Python compile and `git diff --check`; line-ending notices only |

### Independent post-smoke direct-code audit

After the final suites and exact-bundle Edge run, each research capability row
was traced through adapter summary, lazy resolver, capability classification,
opaque media registration, player/download/record consumer, EQ scope, favorite
normalization, restart rehydration, cancellation, and teardown.

The direct trace confirmed:

- the player has one generation-owned resolver controller and never attaches a
  provider URL when the same-origin media relay is unavailable;
- finite and live outcomes settle atomically, while transient provider errors
  remain retryable and permanent rights/identity failures become unavailable;
- playback and recording own different media IDs, and recording Stop sends
  only the job-stop request while the player relay remains owned by playback;
- recording snapshots the effective global/favorite EQ curve into FFmpeg;
- download and recording path reservation is atomic, Windows-safe, timestamped
  where needed, and cannot overwrite an existing output;
- startup removes expired opaque media/artwork URLs and re-resolves from stable
  provider identities without deleting favorites or EQ associations; and
- adapter/player disposal aborts outstanding network work, releases relays,
  destroys HLS/DASH sessions, clears media elements, and ignores stale results.

No additional defect remained after the final trace. The earlier resolver,
relay fallback, permanent-Checking, and dynamic-favorite mutation gaps were
already repaired and covered by the final regression evidence above.

### Favorites preservation

- Unit, integration, and browser checks used in-memory storage, temporary
  backend roots, or a freshly generated Edge profile below `build`.
- The production Edge harness seeded exactly two synthetic favorites and
  finished with exactly two; it did not load the normal World Media profile.
- The user's normal application/WebView profile and saved favorites were never
  launched, cleared, migrated, or written during Phase 9.

### Phase 9 exit gate

Complete. All five sources have honest end-to-end playback/capture/EQ and
restart behavior, existing six-source paths remain green, and saved user data
was not touched.

## Phase 10 - Combined reliability, security, and performance

Status: complete on 2026-07-15. Phase 11 is next.

### Measured reliability and performance

The isolated, packaged 15-minute baseline loaded all eleven production adapter
chunks, performed 57 metadata proxy completions over 31 active seconds, never
exceeded five completions in a logged second, stayed health-responsive, and
shut down cleanly in 2.927 seconds. The complete eight-process
EXE/WebView2 tree plateaued rather than growing:

| Time | Working set | Private | CPU seconds | Threads | Health |
|---:|---:|---:|---:|---:|---:|
| 60 s | 593.855 MiB | 499.250 MiB | 18.516 | 198 | 2.884 ms |
| 300 s | 580.738 MiB | 483.566 MiB | 21.969 | 172 | 2.796 ms |
| 900 s | 578.730 MiB | 489.062 MiB | 26.625 | 168 | 2.373 ms |

This is below the approved 900-MiB working-set/750-MiB private target and is a
substantial improvement over the unbounded Phase 0 716.72/591.73-MiB
89.8-second observation.

The exact final hashed production bundle then measured:

| UI metric | Result |
|---|---:|
| First catalog card | 145.8 ms |
| Rapid debounced search to matching partial result | 462.2 ms |
| Programmatic long-scroll frame p95 | 24.5 ms |
| Maximum mounted cards after 900+ accumulated items | 300 |

The resource benchmark transferred 64 MiB through the media relay at 72.05
MiB/s with only 0.381 MiB traced-memory growth and 2.223-ms health p95. During
a real balanced video recording, control p95 was 2.984 ms; FFmpeg averaged
85.92% and peaked at 189.8% process CPU, or 7.16%/15.82% normalized across the
machine's logical CPUs. Five thousand rapid EQ updates created no idle audio
context.

No performance constant required post-hoc relaxation at this checkpoint. The
then-current values were catalog 4 global/2 per source, artwork 6 global,
prefetch 330/660, 6,000
resident items with protected pins, 300 mounted cards, catalog cache
256 entries/64 MiB/64 per provider, artwork cache 512 entries/256 MiB, and
snapshot cadence clamped to 30 seconds-30 minutes.

### Stress, security, and package evidence

| Gate | Result | Evidence |
|---|---:|---|
| Scheduler property/stress | Passed | 2,200 eleven-source operations; global/per-source limits, fairness, priority, dedupe, cooldown, cancellation, hidden pause, and zero slot/timer leak |
| Simultaneous provider faults | Passed | LOC cooldown, dead feeds, PeerTube origin failures, Owncast rating failure, C3VOC empty live, and old-source faults remained isolated |
| Catalog-store churn | Passed | 120 cycles/7,200 insertions with rotating snapshots, ceiling, pins, index, source/type counts, and eviction invariants intact |
| Exact Edge catalog stress | 13/13 | 41 fixture calls, maximum one active, 300 DOM ceiling, retry/no false completion, search, scroll, tab/source cancellation, two synthetic favorites preserved |
| Exact Edge full production UI | 17/17 | Exact `/assets/index-CnGG5ejq.js`; playback, EQ, HLS, all modes, settings, themes, source toggles, favorites, stop, and no browser errors |
| JavaScript regression | 262/262 | Complete suite including four new central artwork-boundary regressions |
| Native/backend regression | 133/133 | Complete discovery suite; final packaging exclusion also repeated 2/2 focused |
| Frontend build | Passed | 73 modules and all eleven source chunks; only the recorded dash.js/CommonJS and large-chunk warnings |
| Hidden packaged-native smoke | Passed | Final EXE started six isolated WebView2 processes, requested the production frontend, accepted authenticated shutdown, exited 0, and released its listener |
| Long packaged smoke | Passed | Health responsive at all intervals and no orphan UI/backend process |

Complete SSRF/DNS/redirect, XML/DTD/entity/budget, JSON/GraphQL, M3U/rating,
asset MIME/magic/dimension/TTL, media Range/HLS/DASH, explicit-content, cache,
control-auth, and shutdown regressions passed. Default-off fixtures never
rendered marked content or provider HTML; deliberate opt-in rendered only
validated, labeled marked items.

The cache/log/localStorage/download-metadata scan found no session/control
token, cookie/auth header, raw malicious fixture, private endpoint, or
unredacted overlong URL. The one source-code secret-pattern match was the
deliberately named settings authorization parameter, not a credential.

Dependency metadata and both notices files were reconciled with the frozen
environment. The one-file archive contains exact `defusedxml.ElementTree`,
Windows `winforms`/`edgechromium`, catalog/media services, notices, and all
eleven chunks. It excludes optional `defusedxml.lxml`, lxml, and unused
Android/CEF/Cocoa/GTK/MSHTML/Qt platform modules. The Phase 10 candidate is
18,902,129 bytes, timestamp `2026-07-15 12:50:50 -07:00`, SHA-256
`AAB4973F41FE63049B584EDF2EA125FC69B5AC242802678AE10A5E2803678724`.

### Independent direct-code maps

**Outbound connection map**

1. Fixed catalog metadata uses only `ALLOWED_HOSTS`/approved Radio Browser and
   Archive suffixes plus the ten exact new `FIXED_METADATA_HOSTS`.
2. Dynamic feeds and PeerTube origin detail use narrow authenticated semantic
   routes, exact parsed identities, and `SafeConnector` public-DNS/redirect
   validation. Owncast uses its two fixed directory URLs.
3. Every thumbnail from all eleven providers now registers through the bounded
   native asset service. Library cards/details, Grid, Discovery, and the player
   attach only exact opaque `/api/v1/assets/{id}` paths.
4. Playback, downloads, and recordings attach only opaque media registrations;
   provider media never reaches an element or job request directly.
5. External Source links pass `safeExternalUrl` and allow only canonical,
   credential-free HTTP(S). They are click-only and are not background fetches.

**Ownership and cleanup map**

`mode generation -> fair catalog queue -> adapter cursor/snapshot -> catalog
store -> 300-card window -> lazy artwork queue -> opaque asset/media
registration -> player or capture job -> stop/mode/source disable/cache clear/
shutdown`. Each queue has one owner and bounded count; generations and abort
signals reject stale publication; snapshot timers pause with visibility;
unmounted observers/listeners disconnect; request maps delete in `finally`;
cache LRU/TTL evicts; player/capture own separate media IDs; shutdown disposes
adapters, timers, assets, media, jobs, FFmpeg, server, and WebView process.

**Failure-state map**

- A page is finite complete only after an adapter explicitly returns
  `exhausted:true`; transport/schema/429/CAPTCHA/suspicious-zero paths retain
  cursors and become retrying, rate-limited, partial, or stale.
- Internet Archive rotates/retries allowed collections before exhaustion;
  IPTV clears failed preload state; NASA/Wikimedia keep independent cursors.
- LOC preserves the exact lane cursor under its shared 10/minute gate and
  bounded CAPTCHA cooldown. gPodder isolates dead feeds and retains LKG.
- PeerTube distinguishes validated zero/total exhaustion from index/origin
  failure. Owncast requires a consistent rating join and otherwise fails
  closed/stale. Empty C3VOC live data is a valid refreshable snapshot, not a
  statement that the VOD catalog is complete.
- The UI therefore retains distinct loading, more available, complete,
  snapshot, stale, retrying/rate-limited, disabled, partial, and unavailable
  states; no caught error is converted to an empty successful page.

**Rights/content/action map**

- CCC VOD downloads only its selected official finite resource; C3VOC live
  records. LOC downloads only with an explicit applicable allow and no access,
  download, or rights restriction. Podcasts download finite publisher
  enclosures and record only currently live enclosures.
- PeerTube VOD requires `downloadEnabled` plus a concrete public file; live
  PeerTube and Owncast record only. Unknown/restricted outcomes never acquire a
  Download button. License labels remain provider metadata or an honest
  source-specific "See ..." fallback, never an invented public-domain claim.
- IPTV, podcasts, PeerTube, and Owncast feed the one three-state content field.
  Exact explicit is hidden by default across every mode, detail, artwork,
  playback, capture, and favorite view; only the direct Settings gesture
  enables labeled results. Turning it off cancels work and stops marked media
  without deleting favorite identity or EQ scope.

### Audit findings and repair/retest loop

The independent reread found and repaired three gaps after otherwise-green
smoke:

1. untrusted `source_url` metadata could reach an external-link `href`; item
   normalization and the detail consumer now require canonical credential-free
   HTTP(S), with script/data/file/backslash/control regressions;
2. the original six adapters still exposed provider thumbnail URLs directly;
   `artwork.js` now centralizes all-eleven relay registration, concurrency,
   retry, dedupe, stale-consumer guards, and display-only opaque validation;
3. PyInstaller's platform selector still discovered unused non-Windows
   pywebview modules; the Windows-only spec now excludes them explicitly.

Each finding received a focused test, affected full suite/build, exact final
bundle Edge run, archive reread, and a second connection/lifecycle trace. No
severity-high or severity-medium defect remains in Phase 10 scope.

### Favorites preservation

Every source/native/browser/package run used in-memory state or a disposable
root/profile below `build`. Browser gates seeded exactly two synthetic
favorites and retained both. The packaged native smoke used an empty isolated
state root. The normal World Media/WebView profile was never opened, migrated,
cleared, or written.

### Phase 10 exit gate

Complete. The eleven-source system meets its measured budgets, all outbound
and failure paths are classified, the security/privacy/content/rights and
cleanup maps close without a gap, and no unresolved high/medium defect remains.

## Phase 11 - Accessibility, documentation, release, and final audit

Status: complete on 2026-07-15.

### User-visible discovery pause clarification

During this production checkpoint, direct inspection showed the then-current
330/660 Library back-pressure gate pausing when unseen items were already
resident ahead of the render window. The owner later clarified that continuous
collection is required. The viewport pause was removed; current code advances
all available source cursors independently. The later owner correction also
removed the 6,000-item resident ceiling; the 300-card sliding DOM window remains
only a rendering optimization and does not discard catalog data.

### Accessibility and interface completion

- Library cards now use one native open button plus a separate native favorite
  button; there is no nested or synthetic interactive control.
- Card, favorite, source, band, type-filter, navigation, player, capture, and
  dialog controls expose names and pressed/current states. Focus rings remain
  visible in forced-colors mode and motion is suppressed under reduced-motion.
- Library details have a labeled region, focused Close control, focus return,
  Escape handling, and selected-detail restoration across mode navigation.
- Capture announcements report state transitions without repeating byte/time
  progress every second.
- The status row is a polite live region and every retry/complete/more/stale/
  paused state has text independent of color.
- The exact production bundle passed keyboard navigation, all seven themes,
  200 percent zoom, reduced-motion capability, settings focus, player controls,
  HLS start/stop, and all five modes in installed Microsoft Edge.

The first exact-bundle run found one real stacking defect: Escape used to close
both the EQ dialog and the non-modal Library detail behind it. The detail
shortcut now acts only while focus is inside that panel. Focused tests, rebuild,
and the full exact-bundle run then passed.

### Documentation and compliance

README, About, Settings source copy, CREDITS, CHANGELOG, file tree, build guide,
release checklist, provider reference, troubleshooting, privacy/network
behavior, rights guidance, and third-party notices now describe all eleven
sources. `docs/PROVIDERS.md` records provider endpoints, caches, no-key status,
refresh behavior, explicit-content behavior, and limitations. The shared Python
notice deliberately names the Python 3.13 runtime family because the classic
one-file build contains 3.13.11 while the folder/ZIP launcher embeds the pinned
3.13.14 distribution.

### Final deterministic and production evidence

| Gate | Result | Evidence |
|---|---:|---|
| JavaScript regression | 264/264 passed | Complete `npm test` after the final focus repair |
| Python/backend regression | 133/133 passed | Complete unittest discovery after the final build; one earlier host-filter socket abort passed immediately in isolation and did not recur |
| Frontend build | Passed | Vite transformed 73 modules and produced all eleven lazy source chunks; recorded dash.js CommonJS/large-chunk warnings only |
| Exact production UI | 21/21 passed | `/assets/index-1mCxRz-R.js`, all modes, accessibility states, themes, 200% zoom, audio/EQ, HLS, cleanup, and zero browser errors |
| Visual review | Passed | Exact production screenshot at 1600 x 1000 had aligned navigation, cards, metadata, detail panel, and focus treatment with no clipping/overlap |
| Diff/syntax hygiene | Passed | `git diff --check`; line-ending notices only; Python harness compilation passed |
| Fixture/provider matrix | Passed | Defended five-source fixtures plus the existing six-source regression matrix are included in the complete suites |
| Shipped-input scan | Passed | No test route, UI harness marker, live-test flag, debugger, authored TODO/FIXME, test file, fixture, state, download, tool, log, or partial output ships |

The later owner clarification restored continuous collection with eleven
global source slots and provider-specific pacing. A subsequent direct test
confirmed retention beyond 40,000 items with no disappearing source counts;
the 300-mounted-card rendering window remains unchanged.

### Polite opt-in live matrix

Every command used a unique state/portable/temp root below `build`; live
failures were reported as provider observations rather than fixture defects.

- gPodder returned 20 directory entries, capped work at global four/per-host
  one, resolved two feeds containing 1,335 episodes, and isolated one publisher
  status failure plus one XML-complexity rejection without downloading media.
- PeerTube returned 30 browse, 30 search, and 30 live-index summaries; a VOD and
  current live candidate both resolved to HLS. One unpublished live candidate
  was skipped before the next candidate succeeded.
- Owncast returned 69 rated directory entries (58 safe, 11 explicit), resolved
  a reachable 1080p H.264/AAC HLS stream, recorded a valid 852 x 480 H.264/AAC
  MP4, preserved the last snapshot through an unreachable case, and left zero
  workers.
- The Phase 3 and Phase 4 official live smokes remain the current C3VOC and
  Library of Congress evidence; deterministic captures remain the release
  oracle when those public services vary.

### Packaged real-media evidence

The classic single EXE, launched with an isolated state root and no browser,
discovered capable PATH FFmpeg, probed HLS directly and through the opaque
relay, downloaded and hashed a 9,436,391-byte MP3, recorded a 17.304-second MP3,
recorded a 6.100-second 1280 x 720 H.264/AAC MP4, opened both recordings through
Windows media APIs, left no partial, exited zero, and released its listener.

The ZIP was extracted to a new disposable folder with a sanitized PATH. It
started with FFmpeg missing, installed the confirmed managed asset, verified
the 167,400,019-byte archive digest and provenance/license files, repeated the
same download, produced a 17.304-second MP3 and 12.583-second 1280 x 720
H.264/AAC MP4, passed Windows opening/ffprobe, left no staging files, exited
zero, and released its listener.

### Final artifact identity

| Artifact | Bytes | Timestamp (America/Chihuahua) | SHA-256 | Signature |
|---|---:|---|---|---|
| `dist\\WorldMediaWindows.exe` | 18,903,104 | 2026-07-15 13:59:32 -07:00 | `07B3C30991B6D8AD3F2CFE339D6702C891A840DA597E91D6C9538AE01811257F` | NotSigned (expected local PyInstaller artifact) |
| `dist\\WorldMediaWindows-0.1.2-portable.zip` | 14,612,151 | 2026-07-15 14:00:18 -07:00 | `CEEEE736BA29D3156ECE23C5B7364FC9644A8A93B3AD08E9B4FD22B254035551` | Archive; launcher verified below |
| `dist\\WorldMediaWindows\\WorldMediaWindows.exe` | 104,160 | 2026-07-15 13:59:51 -07:00 | `95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4` | Valid, Python Software Foundation |

### Independent final direct-code audit

The shipped code was reopened after every final smoke item and mapped again:

1. **Input to output:** the immutable registry contains exactly eleven IDs and
   one lazy loader each. New adapter summaries enter the shared item contract;
   lazy resolution then registers artwork/media through authenticated opaque
   localhost routes before any card, detail, media element, download, or record
   job consumes it.
2. **Failure/status:** only explicit adapter exhaustion becomes complete.
   Transport, schema, suspicious-zero, CAPTCHA, 429/Retry-After, partial feed,
   stale snapshot, and unavailable identity outcomes retain distinct states and
   retryable cursors. The UI exposes each state in text, including bounded
   discovery pause.
3. **Rights/content/actions:** finite downloads require provider-authorized
   resources; live items record; restricted or unknown results never gain a
   download action. Exact explicit content remains hidden by default and can be
   enabled only by the direct Settings gesture.
4. **Persistence/migration:** saved favorites retain stable provider identity,
   unknown future fields, and per-favorite EQ while expiring local artwork/media
   tokens are stripped and dynamically rehydrated. The 58-favorite migration
   fixture remained exact.
5. **Ownership/cleanup:** mode generations own scheduler work; adapters own
   caches/gates/controllers; player and capture own separate opaque media IDs;
   teardown aborts stale work; shutdown covers catalog, asset, recording, job,
   download, FFmpeg, server, and WebView owners.
6. **Outbound/security:** fixed metadata hosts and narrow semantic dynamic-feed/
   PeerTube routes pass public DNS, redirect, token/origin, size, XML/M3U/JSON,
   MIME/magic, and path validation. External Source links accept only canonical
   credential-free HTTP(S).
7. **Package:** the folder/ZIP contains production frontend/runtime/notices and
   all five new chunks, but no test routes/files, fixtures, profiles, favorites,
   logs, downloads, tools, secrets, or partial outputs. No isolated process was
   left after final verification.

No unresolved production finding remained on the second trace.

### Favorites preservation

All browser, live, backend, and package runs used memory storage or unique roots
and Edge profiles below `build`. The production UI harness seeded two synthetic
favorites and retained exactly two. The user's normal application/WebView
profile and saved favorites were never opened, migrated, cleared, or written.

### Final 10/10 gate verdict

Contract correctness, feature completeness, reliability, security/privacy,
rights/content preference, performance, playback/capture, persistence/migration,
UI/accessibility, and release evidence each have direct passing evidence. The
technical release candidate is therefore rated 10/10 under the plan's bounded,
evidence-based definition. Publishing/tagging remains intentionally unperformed
because it was not requested and is not an implementation defect.

### Phase 11 exit gate

Complete. All Phases 0-11, every required smoke and independent audit, and all
ten quality gates are closed against the final artifacts above.

## Post-Phase 11 - Continuous collection bottleneck audit

Status: complete on 2026-07-15.

The owner requested an unrestricted bottleneck pass after confirming that the
catalog must continue beyond 40,000 items. Direct traces found and removed the
following hot paths without adding a catalog ceiling:

- full-session Library filtering after every 30-item page and a duplicate
  sentinel scan;
- full IPTV inventory filtering on every cursor page;
- full artwork/media registration scans on every token lookup, including every
  HLS/DASH segment;
- full catalog/artwork cache directory scans and physical flushes on every new
  response/image;
- artwork jobs with no terminal watchdog and a conservative six-lane queue;
- successful high-volume localhost requests being line-flushed to an unbounded
  log; and
- repeated unchanged sidebar DOM writes during collection.

Current boundaries are eleven independent catalog lanes, a 60-second final
catalog watchdog, 100 ms append/render pacing, twelve artwork lanes, a
25-second artwork watchdog, 24 eager cards, 1,800 px thumbnail prefetch, sixteen
asset relay slots, a 240-request/second localhost control allowance, and a
128-request listen backlog. Cache and token registries remain bounded safety
structures; none discards catalog items.

Final deterministic evidence: 270/270 JavaScript tests, 143/143 Python tests,
Python compilation, 73-module Vite build, and isolated portable startup/health/
authenticated shutdown/exit/listener-release all passed. The refreshed classic
and personalized test EXEs are both 18,909,389 bytes with SHA-256
`7EA3029CEBC83C6B428209D6CFEB5A8F2054075ACCFF59BD589B98634FD76ED4`.
The personalized data tree remained exactly 3,116 files with pre/post manifest
SHA-256 `422DCD2626BFB33B4A25EC17FDC933C86639F87FA56F20BBEB023B0712A5D6B9`.
