# Player Capture and Equalizer Execution Log

This log is the durable evidence ledger for
[PLAYER_CAPTURE_EQ_PHASES.md](PLAYER_CAPTURE_EQ_PHASES.md). A phase is recorded
as complete only after its implementation, smoke-test, and separate direct-code
self-audit gates all pass.

## Phase 0 — Contracts and test infrastructure

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Frozen the current player DOM, desktop/compact/narrow layout breakpoints,
  settings sections, item model, all six adapter module contracts, legacy API
  routes, and native runtime paths in
  `tests/fixtures/baseline-ui-contract.json`.
- Added frontend DOM/media doubles in `tests/helpers/fake-dom.js` and direct
  contract/harness coverage in `tests/contracts.test.js` and
  `tests/harness.test.js`.
- Added a standard-library Python suite under `tests_python/`.
- Added a reusable threaded localhost fixture server for finite audio/video,
  byte ranges, endless streams, HLS VOD/live playlists and segments, public and
  private-target redirects, required request headers, delayed responses,
  interrupted bodies, and malformed JSON/HLS.
- Added deterministic process, process-factory, and clock doubles.
- Frozen Draft 2020-12 response-data schemas and examples for session, runtime,
  FFmpeg tool status, media registration, and capture jobs.
- Connected Python discovery to `.github/workflows/ci.yml`; JavaScript tests,
  Python tests, frontend build, and Python entry-point parsing now run in CI.
- Phase 0 changed test/fixture/CI/documentation files only. The Vite build
  reproduced the pre-phase production asset hashes.

### Smoke-test evidence

- Focused harness run: 15/15 JavaScript checks passed and 10/10 Python checks
  passed.
- Full corrected run: 16/16 JavaScript checks passed.
- Python suite: 10/10 passed, then passed three consecutive runs (30/30) to
  check cancellation/server-thread determinism.
- Every root and `tests_python` Python file parsed successfully with `ast`.
- Every added JSON fixture and schema parsed successfully.
- `npm run build`: passed; 44 modules transformed and production hashes remained
  `index-CuZNHBM9.css` and `index-NjW-9HK4.js`.
- Source server baseline: health `ok=true`, static index HTTP 200, graceful
  shutdown accepted.
- Existing packaged executable baseline: health `ok=true`, static index HTTP
  200, graceful shutdown accepted; size 18,377,114 bytes.
- `git diff --check`: passed. Git emitted only existing LF-to-CRLF notices.

The in-app browser was not attached during this phase. Interactive screenshots
were therefore not claimed as evidence. The responsive baseline is frozen from
the production DOM/CSS and exercised structurally; the source and packaged
runtime HTTP surfaces were smoke-tested directly.

### Independent direct-code self-audit

Connection map reviewed after the smoke gate:

```text
src/index.html + src/styles/base.css + settings/item-model/sources
        -> baseline-ui-contract.json
        -> contracts.test.js
        -> package.json `node --test tests/*.test.js`
        -> CI `npm test`

tests_python/fixture_server.py + tests_python/fakes.py
        -> test_fixture_server.py + test_fakes.py
        -> unittest discovery
        -> CI Python test step

schemas/*.schema.json + contract_examples.json
        -> test_contract_schemas.py
        -> unittest discovery
```

The first independent review found two incomplete baseline assertions: player
metadata/narrow-layout details were not explicit, and adapter outputs were only
indirectly covered. Both were corrected by extending the frozen contract and
adding a network-free adapter export/normalization test. The complete smoke gate
was rerun afterward.

The final review confirmed:

- all six adapters are represented and return normalized items accepted by the
  current validator;
- media fixtures bind only to ephemeral `127.0.0.1` ports and close server
  threads on teardown;
- cancellation, partial-body, redirect, header, and Range branches are reached
  by tests rather than existing as unused helpers;
- fake time never sleeps on wall time and fake process cancellation has an
  observable terminal code;
- schemas are closed at their top level and examples contain every required
  field;
- CI and local runner globs discover every new test;
- no production module imports the test harness and no production behavior was
  changed in Phase 0.

Final Phase 0 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 1 — Player state ownership and play/pause UI

Status: complete

### Implementation evidence

- Added `src/lib/player-state.js` with explicit active-element ownership and a
  monotonically increasing playback generation.
- Replaced permanent dual-element event writers with generation-captured event
  bindings that are removed on every switch and stop.
- Added `syncPlaybackUi(reason)` as the only writer of `state.isPlaying`, the
  play/pause SVGs, play button title/label/pressed state, and seek/time/duration
  presentation.
- Added guarded handling for play, playing, pause, ended, emptied, error,
  timeupdate, metadata, duration changes, HLS fatal errors, rejected promises,
  no-source selections, stop, and rapid source replacement.
- Added supported Media Session play, pause, and stop actions through the same
  player methods. Stopped state is reported as `none`.
- Public player entry points remain compatible with all Library, Tuner, Grid,
  and Discovery callers.

### Smoke-test evidence

- Focused player suite: 3/3 passed, including the complete lifecycle matrix.
- Focused suite repeated five consecutive times: 15/15 passed.
- Full JavaScript regression: 19/19 passed.
- Full Python regression: 10/10 passed.
- JavaScript syntax checks and `git diff --check`: passed.
- Vite production build: passed with 45 transformed modules.
- PyInstaller one-file rebuild: passed.
- Rebuilt executable: health true, static UI HTTP 200, corrected Phase 1 bundle
  found as `assets/index-BwD6ZzWz.js`, graceful shutdown accepted; executable
  size 18,375,791 bytes.

### Independent direct-code self-audit

```text
all player callers -> playItem/togglePlay/stop
                         |
                         v
                 playback generation owner
                         |
       active generation-captured media events only
                         |
                         v
                  syncPlaybackUi
       -> state -> icons/labels -> seek/time -> Media Session
```

The independent review found and corrected three edge gaps after initially
passing tests:

1. a rejected `play()` on a reused element needed to be treated explicitly as
   a retry state;
2. selecting an unresolved/no-source item needed to release the prior source
   immediately;
3. stopped Media Session state and Radio Browser click tracking needed final
   ownership/success guards.

After correction, the full smoke gate and packaged build were repeated. A final
static invariant audit confirmed exactly one writer call site for playback
state, each icon, the play accessibility label, and the seek presentation; all
required lifecycle events and ownership invalidations are connected.

The initial automated audit could not claim the live packaged matrix because the
in-app browser was not attached. That gate was subsequently completed through
the user-operated retests documented below.

### Live packaged retest addendum

The first user-operated packaged test exposed two failures that the original
DOM fake had masked:

- the test build was launched on port 19174, so WebView2 used a different
  localStorage origin and existing favorites appeared absent; raw LevelDB
  evidence confirmed the favorites remained under the normal port 9124 origin;
- SVG elements did not reliably reflect assignments to the HTML-oriented
  `.hidden` property, so the Play triangle remained visible while media played.

The player now changes the SVG `hidden` attributes explicitly with
`toggleAttribute()`. The DOM fake was corrected to model attribute-backed hidden
state, and tests assert both property and attribute visibility. A second live
failure—an interim media error cancelling a pending `play()` and leaving stale
error text after retry—was also fixed by centralizing pending play attempts and
restoring metadata on success.

After rebuilding, the packaged bundle was verified to contain the SVG attribute
fix and relaunched on `http://127.0.0.1:9124`. The user confirmed live radio now
autoplays, shows Pause while playing, and shows Play after pausing. On-demand
audio, direct video, and HLS video were then confirmed working with Pause while
playing and Play while paused. This completes the Phase 1 manual matrix.

Final Phase 1 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 2 — Media capability and EQ persistence contracts

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Extended the normalized item contract with explicit delivery, download URL,
  suggested filename, and allowlisted capture-header fields. Header values with
  CR, LF, NUL, excessive length, or unknown names are discarded.
- Added `src/lib/media-capabilities.js`, whose pure action resolver returns only
  `download`, `record-audio`, `record-video`, `checking`, or `unavailable` and
  contains no source-specific branches.
- Added conservative HLS and DASH inspection. Declared adapter delivery always
  wins; unknown HLS master playlists can inspect either a stream variant or an
  `EXT-X-MEDIA` child before deciding; static DASH maps to on-demand and dynamic
  DASH maps to live.
- Mapped Radio Browser, IPTV-org, Internet Archive, NASA, Wikimedia Commons,
  and LibriVox to the approved capability contract. Lazy resolvers update the
  playback and download targets in the same operation.
- Added versioned compact, balanced, and high recording profiles.
- Added versioned EQ normalization/persistence for a global curve, favorite
  curves, and custom presets, with ten clamped bands and forward-compatible
  preservation of unknown fields.
- Migrated legacy favorites/settings without resetting valid user data. Added
  automatic favorite/unfavorite EQ transitions and clarified that cache clear
  removes preferences/EQ/job history while retaining downloads and tools.
- Connected the resolver through the live player facade so production bundling
  cannot tree-shake the capability implementation.

### Smoke-test evidence

- Focused contract/capability/EQ suite: 12/12 passed, then passed three
  consecutive runs (36/36) after the final corrections.
- Full JavaScript regression: 28/28 passed.
- Full Python fixture/contract regression: 10/10 passed.
- Vite production build: passed; 48 modules transformed. Final entry bundle is
  `assets/index--n2io3CP.js` (82,729 bytes served).
- PyInstaller clean one-file rebuild: passed. Final executable size is
  18,377,988 bytes.
- Packaged executable smoke: health HTTP 200, app shell HTTP 200, entry bundle
  HTTP 200, and EQ/record-audio/record-video integration markers all present.
- Twelve affected adapter/core modules passed `node --check`; `git diff --check`
  reported no whitespace errors (only repository line-ending notices).

The package probe initially exposed that the standalone capability module was
tree-shaken because no production caller referenced it. The player facade was
connected and the full build/package gate was repeated. A literal minified-text
probe for `EXT-X-MEDIA` was discarded as an invalid bundle assertion; behavior
is instead proven by source invariants and executable module markers.

### Independent direct-code self-audit

```text
six adapters -> normalized capability fields
   |              |
   |              +-> lazy resolver updates stream + download target
   v
player current item -> pure action resolver -> future capture control

localStorage settings/EQ -> validators -> global effective curve
                                      -> favorite transition clone
                                      -> unfavorite delete + global restore
```

The first post-smoke review found two genuine edge gaps:

1. HLS masters using only an `EXT-X-MEDIA:URI` child were not inspected; support
   and regression coverage were added.
2. An orphaned legacy per-item EQ curve could be revived when re-favoriting an
   item. Favorite transition now always snapshots the currently effective
   curve, replacing stale orphan data.

Each correction restarted the complete focused/full/build/package sequence.
The final audit then checked all 24 required adapter-field occurrences, zero
source IDs in the pure resolver, six manifest/action invariants, sanitized IPTV
public metadata with no private-header leak, three player connections, five
state/EQ connections, five EQ persistence invariants, all lazy download/playback
assignments, cache confirmation wording, and JavaScript syntax. No additional
gaps were found.

Final Phase 2 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 3 — Secure localhost control foundation

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Added `worldmedia_security.py` for per-launch 384-bit session tokens, exact
  Host/Origin checks, constant-time token validation, duplicate-header
  rejection, strict UTF-8 JSON content type, 64 KiB body limits, structured
  versioned envelopes, redaction, Windows filename safety, and atomic output
  reservation.
- Added `worldmedia_runtime.py`. Frozen portable paths derive from
  `sys.executable`, never PyInstaller `_MEIPASS`; source paths derive from the
  repository. Downloads resolve to `<portable>\downloads`, tools to
  `<portable>\tools\ffmpeg`, and both use private atomic writability probes.
- Added `worldmedia_jobs.py`, a lock/condition-backed registry with explicit
  monotonic states, duplicate idempotency, one-recording/two-download limits,
  bounded terminal history, root-validated output publication, safe errors,
  cancellation/stop controllers, and bounded shutdown waiting.
- Added `/api/v1/session`, `/api/v1/runtime`, authenticated job reads, and
  authenticated job stop/cancel dispatch. Every control response uses a v1
  envelope and request ID; control routes never add wildcard CORS or accept
  query parameters.
- Secured legacy shutdown with the same exact Origin/token/JSON requirements.
  Both native window teardown and server teardown call the job shutdown hook.
- Replaced raw request-line logging with bounded request-ID logs that omit query
  strings and redact URLs, credentials, relay tokens, and token assignments.
- Updated Windows CI to parse every `worldmedia*.py` module, the frozen route
  contract, runtime contract example, build smoke instructions, and file tree.

### Smoke-test evidence

- Final focused security/runtime/job/schema suite: 13/13 passed.
- Security/runtime/job core suite passed three consecutive runs (33/33) during
  determinism/race testing; the final corrected suite passed again afterward.
- Full final JavaScript regression: 28/28 passed.
- Full final Python regression: 21/21 passed.
- All six build/runtime Python entry modules compile with `py_compile`.
- Source runtime: health 200, static shell 200, session/runtime authenticated,
  64-character tokens rotated across independent launches, authenticated
  shutdown 202, and each process exited.
- Vite production build: passed with 48 transformed modules and entry bundle
  `assets/index--n2io3CP.js`.
- Clean PyInstaller rebuild: passed. Final executable size is 18,405,313 bytes.
- Final packaged runtime: health/static/bundle all 200; session token length 64;
  portable root `E:\WorldMediaWindows\dist`; downloads and tools roots exactly
  beside the EXE; portable probe writable; unauthenticated shutdown 403;
  authenticated shutdown 202; process fully exited.
- `git diff --check` found no whitespace errors, only repository line-ending
  notices.

The focused smoke exposed two issues before the first package gate: slotted
exception construction needed an explicit base initializer, and rejecting a
POST before reading its body left bytes on an HTTP/1.1 keep-alive connection.
The latter is now closed explicitly on control errors and covered by an
assertion. Both fixes were retested before packaging.

### Independent direct-code self-audit

```text
same-origin frontend -> GET session -> per-launch token
        |
        +-> authenticated GET -> runtime/job snapshots
        |
        `-> exact Host + Origin + token + JSON -> stop/cancel/shutdown

native/server shutdown -> JobRegistry.shutdown
                         -> cancel finite work / stop recording
                         -> bounded wait / safe terminal failure

portable EXE root -> downloads + tools probes
                  -> sanitizer -> atomic reservation
                  -> root-validated job output publication
```

The first post-package audit found and corrected three deeper gaps:

1. duplicate security headers needed explicit rejection rather than first-value
   handling;
2. job responses needed immutable snapshots taken while holding the registry
   lock;
3. cancellation callbacks needed to run before terminal cancellation so a
   failed controller cannot leave work running behind a false `cancelled`
   state.

That correction triggered the entire full/source/build/package sequence again.
The final independent pass verified 12 security invariants, 7 runtime-root
invariants, 11 job invariants, 9 handler connections, and 3 native connections.
It confirmed the only wildcard CORS header remains confined to the legacy
metadata proxy and found zero frontend-controlled command, FFmpeg-argument,
shell, or output-path inputs. Direct review also confirmed bounded/redacted
logs, query rejection, safe error envelopes, terminal transition closure,
shutdown reachability, and `_MEIPASS` separation. No further gaps were found.

Final Phase 3 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 4 — Safe same-origin media relay

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Added `worldmedia_media.py` with an HTTP/HTTPS connector that rejects URL
  credentials and non-web schemes, requires every DNS answer to be globally
  routable, connects to the selected numeric address, and retains the original
  hostname for HTTP Host and HTTPS certificate/SNI verification.
- Every redirect is joined against the prior upstream URL and independently
  re-resolved/revalidated. Connect, header, and idle timeouts are bounded;
  chunk iteration is cancellation-aware and detects declared-length truncation.
- Capture headers are independently allowlisted to Referer/User-Agent with
  control-line rejection. Cookie, Authorization, arbitrary headers, compressed
  manifests, invalid ranges, and duplicate Range headers are not accepted.
- Added an opaque registry with 256-bit tokens, per-root child scoping, global
  and per-root limits, six-hour active scopes (up to 24 hours for live media),
  immediate/graceful revocation, and complete shutdown invalidation. Upstream
  URLs never appear in public GET query parameters or relay URLs.
- Added direct GET/HEAD/Range streaming with Content-Length, Content-Range,
  Accept-Ranges, bounded 64 KiB reads, synchronous downstream writes for
  backpressure, independent relay concurrency/rate handling, and clean
  committed-response aborts on disconnect or upstream failure.
- HLS rewriting covers URI lines and URI attributes used by variants,
  alternate media, maps, keys, parts, hints, and segments. Every child is
  resolved against the final upstream manifest URL and receives an inherited
  opaque token.
- Added `src/lib/capture-client.js`; the player registers resolved media before
  attach, routes direct/HLS playback through the local URL, revokes old scopes
  after a switch grace period or immediately on Stop, and emits an explicit
  unavailable event if source-only development must fall back to direct media.

### Smoke-test evidence

- Final JavaScript regression: 30/30 passed.
- Final Python regression: 32/32 passed.
- Focused relay security/integration suite: 11/11 passed; repeated three
  consecutive times for 33/33 additional race/network-lifecycle checks.
- Fixture coverage includes HEAD, finite bytes, valid/invalid Range and seek,
  required headers, public/private redirect behavior, interrupted bodies,
  endless-stream reset cancellation, nested HLS master/media/key/map/segment
  traversal, token expiry, a 1 MiB slow consumer, and relay independence after
  metadata rate exhaustion.
- TLS unit evidence confirms the socket dials the validated numeric IP while
  `wrap_socket` receives the original hostname. DNS-set and second-resolution
  tests reject mixed/private rebinding answers.
- Production-policy source smoke rejected loopback with 403 and relayed
  `https://example.com` through an opaque path with HTTP 200; authenticated
  shutdown exited cleanly.
- Vite build passed with 49 modules and entry `assets/index-Da_VI475.js`.
- Clean PyInstaller build passed. Final EXE size is 18,424,589 bytes.
- Final packaged smoke: health/static/bundle 200; cloud-metadata registration
  403; public registration/opaque relay 200; six-hour finite scope confirmed;
  authenticated shutdown 202 and full process exit.
- The in-app browser backend was not attached (browser discovery returned an
  empty list), so no unavailable automation was claimed. A test-only harness
  opened in the user browser and, after the required user gesture, reported:
  analyser peak 47, audio ended true, direct MP4 ended true, and rewritten HLS
  ended true. All three playback sources were opaque relay paths. The harness
  and its temporary media were then stopped/removed and are not packaged.

### Independent direct-code self-audit

```text
normalized item -> authenticated register -> opaque root token
                                             |
media element/FFmpeg -> local token GET -> pinned connector -> public IP only
                                             |
HLS manifest -> absolute upstream children -> scoped opaque child tokens

switch -> 5-second old-scope grace
stop/shutdown -> immediate registry invalidation
```

Pre-smoke review caught and corrected global child-cap enforcement, compressed
manifest handling, long-playback scope duration, and stable upstream identity.
Interrupted-body testing then exposed two deeper committed-stream issues: an
error path could attempt a second JSON response after media headers, and early
EOF could leave the downstream waiting on the original Content-Length. The
handler now half-closes committed failures and the iterator explicitly detects
a positive remaining length. The full smoke/package chain was restarted after
the final correction.

The final post-browser audit verified connector pinning/timeouts, redirect
revalidation, registry scope/limits, all handler streaming headers and abort
paths, frontend registration/revocation connections, independent rate dispatch,
zero public upstream-URL inputs, and zero relay wildcard-CORS headers.
`git diff --check` found no whitespace errors, only repository line-ending
notices. No further gap was found.

Final Phase 4 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 5 — Verified FFmpeg discovery and installation

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Added `worldmedia_ffmpeg.py` with ordered `override` → portable → `PATH` →
  LocalAppData discovery. Every candidate must execute both ffmpeg and ffprobe
  successfully and expose the HTTP/HTTPS/pipe protocols plus the HLS/MOV/MP3/
  MPEG-TS demuxers, AAC/H.264/MP3 decoders, AAC/libmp3lame/libx264 encoders,
  and MP3/MP4 muxers required by the fixed capture profiles.
- Added authenticated `/api/v1/ffmpeg/status`, install, repair, cancel, and
  managed-remove routes. Inputs are closed to an explicit confirmation boolean
  and the `portable`/`LocalAppData` destination enum; no URL, command argument,
  output path, executable path, or shell input crosses the frontend boundary.
- Pinned acquisition to `BtbN/FFmpeg-Builds` and the exact
  `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` release asset. Repository identity,
  release state, asset count/name/state/type/size, GitHub URL, and GitHub SHA-256
  digest are independently checked across DNS-pinned, allowlisted GitHub hosts.
- The bounded downloader streams to a private partial file with cancellation,
  connect/header/idle timeouts, retry, declared/actual length checks, a 320 MiB
  ceiling, incremental SHA-256, and fsync. A mismatched digest is deleted and is
  never opened as an archive or executed.
- ZIP inspection bounds all entries, expanded/member size, and compression
  ratio; verifies CRC; and rejects traversal, absolute/drive/backslash/control,
  Windows ADS/device/trailing-name, duplicate case-folded, encrypted, symlink,
  junction-backed root, and missing executable/license cases.
- Extraction is cancellation-aware, confined to a random staging directory,
  exclusive-create only, and flushed before the staged capability probe. A
  verified sibling-directory rename and atomic `current.json` switch activate
  the new version only after all checks. Failed pointer commits remove the
  orphan and preserve the prior selection.
- Windows scanner/file locks receive bounded retry during commit and cleanup.
  Repair installs through the same verified pipeline. Removal validates the
  exact managed root, refuses links/junctions, and never targets `PATH` or an
  override. Shutdown cancels and joins an active installer worker.
- Added `src/lib/ffmpeg-client.js` and the Settings Recording Tools panel with
  source/version/path/capability-backed status, progress polling, explicit
  portable versus LocalAppData selection, cancel/repair/remove, and a consent
  dialog naming provider, GPL build family, approximate size, destination,
  digest verification, and license behavior. `installFfmpegAndResume` retains
  the initiating callback for automatic Phase 8 record resumption.
- Added FFmpeg/BtbN attribution and license/source-retention disclosures to
  Settings, About, README, and Windows build documentation. Normal CI remains
  fixture-only; a scheduled/manual Windows workflow runs the large real-provider
  integration separately.

### Smoke-test evidence

- Final focused FFmpeg suite: 15/15 passed, including discovery fall-through,
  process safety, release identity, retry/cancel, bad digest, truncation, CRC,
  traversal/ADS/device/symlink/duplicate paths, file/expansion/ratio bombs,
  missing tools/license/capabilities, atomic rollback, scanner locks, terminal
  status retention, junction refusal, attribution retention, and managed-only
  removal.
- Final JavaScript regression: 33/33 passed, including fixed FFmpeg routes and
  bodies, polling terminal states, abort, and install-and-resume exactly once.
- Final full Python regression after the independent audit: 48/48 passed.
- Vite production build passed with 50 transformed modules; the generated entry
  `assets/index-CPNrDWpF.js` contains the Settings/provider integration.
- The live GitHub metadata check selected release `352173309`, asset
  `472604427`, size 167,400,020, and SHA-256
  `9a9bf189584948296b6ce34a9cd843b58f6d7d9ee42f7139aec448651a55506c`.
- The opt-in real clean-root Windows test downloaded that full asset twice after
  its final corrections. Both final gates verified digest, executable pair,
  GPL license, source record, manifest, managed state, and every capability.
  The reported provider version was
  `ffmpeg version n8.1.2-22-g94138f6973-20260710`.
- The workflow YAML parses and schedules the same real test weekly with manual
  dispatch on `windows-latest`; normal unit tests do not download the asset.
- The post-audit PyInstaller rebuild passed. Final executable size is
  18,453,532 bytes with SHA-256
  `A8B2C21EA9368C95BE6B00ABD198959E05954961B52BC235E707756A0468B023`.
- Final packaged smoke: health and frontend 200; authenticated FFmpeg status
  ready from `C:\ffmpeg\bin\ffmpeg.exe`; HLS and libx264 explicitly present;
  44 protocols, 360 demuxers, 526 decoders, 221 encoders, and 178 muxers; secure
  shutdown 202 and full process exit.
- `git diff --check` found no whitespace errors, only existing repository
  line-ending notices. PyInstaller warnings were conditional/optional platform
  imports; the packaged WebView/server/status smoke exercised the selected
  Windows path successfully.

### Independent direct-code self-audit

```text
Settings consent -> authenticated fixed route -> FfmpegService worker
                                                |
GitHub latest API -> exact asset metadata -> pinned/allowlisted connector
                                                |
partial download -> length + SHA-256 -> hostile-ZIP/CRC inspection
                                                |
exclusive staging -> ffmpeg/ffprobe capabilities -> atomic version + pointer
                                                |
discovery -> override -> portable -> PATH -> LocalAppData -> status/record hook

cancel/shutdown -> cancellation event -> bounded network/CRC/extract/commit exit
remove          -> exact managed enum/root -> reparse refusal -> bounded cleanup
```

The real-provider smoke found a Windows-only failure missed by synthetic ZIPs:
moving a newly executed large staging tree into a fresh child directory was
denied even though cleanup was possible. Activation never occurred. The commit
was changed to an equally atomic same-depth sibling rename, then the complete
real download/install/probe gate passed twice.

The separate post-smoke audit then found and corrected terminal error/cancel
status refresh timing, Windows alternate-data-stream/device/duplicate path
validation, directory-only entry counting, reparse-point managed roots,
transient-lock managed removal, extracted-file flushing, and three newly added
mojibake separators in Settings. Each correction received a focused regression,
then the full real-provider/Python/frontend/build/package chain was repeated.

The final connection review verified all five control routes, exact mutation
schemas, same-origin/token enforcement, worker lifecycle, cancellation at every
long-running stage, error redaction, managed-root confinement, old-selection
rollback, Settings polling/close behavior, resume callback reachability,
attribution links, workflow isolation, PyInstaller inclusion, and packaged
capability reporting. Searches found no shell execution, dynamic command
arguments, frontend-controlled acquisition URL, or unmanaged removal path. No
further gaps were found, and compliance is signed off for subsequent phases.

Final Phase 5 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 6 — Finite original-media downloads

Status: complete
Completed: 2026-07-10

### Implementation evidence

- Added `worldmedia_downloads.py` and the frozen-matrix
  `POST /api/v1/jobs/download` route. The mutation accepts exactly one opaque
  media registration ID; the original URL, headers, title, source, and filename
  suggestion remain backend registration data and never cross the start route.
- Added `src/lib/download-client.js`. `startItemDownload` first exchanges an
  adapter `download_url` for an opaque registration, then starts by ID. Status
  and cancellation reuse authenticated job routes, and fixed-root folder access
  uses `POST /api/v1/downloads/open-folder`.
- The downloader uses the DNS-pinned/redirect-revalidating safe connector and
  exclusive hidden `.part` files under `<portable>\downloads`. It rejects
  symlink/junction-backed roots, confines resolved paths, sanitizes titles, and
  chooses extensions only from bounded source metadata/content-type mappings.
- Known lengths report byte/percentage progress; unknown lengths are explicitly
  indeterminate while still reporting bytes and elapsed time. Zero-byte,
  oversized, invalid-length, HTML/XML/JSON error documents, and obvious
  audio/video type mismatches cannot publish.
- Retry is bounded. Resume requires a known total, byte-range support, and a
  strong ETag or Last-Modified validator. `Range`, `If-Range`, response status,
  start offset, total, remaining length, validator, and content type must all
  agree; weak/changed validators restart from byte zero.
- Cancellation sets the worker event, actively closes its upstream socket, and
  joins bounded cleanup before the registry reports `cancelled`. Shutdown uses
  the same controller path. Partial and reserved-final cleanup retries transient
  Windows locks.
- Final names are collision-safe against active jobs, existing files, and a
  last-moment external collision. Publication reserves the exact final name and
  atomically replaces it only after a complete fsynced transfer; failed and
  cancelled jobs expose no output path and leave no final file.
- Duplicate active work is rejected by normalized internal source URL even when
  repeated clicks create different opaque registrations. The existing two-job
  concurrency limit and bounded history remain enforced by `JobRegistry`.
- LibriVox ZIP content is retained as ZIP and named `Full Audiobook`; direct
  chapter audio remains MP3. Completed downloads are ordinary filesystem files
  and the browser-only cache reset has no filesystem deletion path. Original
  downloads import or invoke no FFmpeg code.

### Smoke-test evidence

- Focused backend download suite: 5/5 passed. It covers known/unknown length,
  public redirect, stable resume, weak validator restart, changed ETag restart,
  exact bytes, collision preservation, duplicate opaque registrations,
  cancellation/socket close/cleanup, HTML and empty responses, HTTP exhaustion,
  write and final-commit failures, reparse refusal, fixed folder opening,
  LibriVox ZIP labeling, and every on-demand source family.
- Authenticated route tests verify opaque-only start bodies, rejected URL/path/
  extra fields, POST-only semantics, fixed open-folder operation, Origin/token/
  JSON enforcement, and structured job status/cancel behavior.
- Final JavaScript regression: 35/35 passed, including URL-to-opaque exchange,
  fixed route bodies, job polling/cancellation, and folder access.
- Final full Python regression after the post-package audit: 54/54 passed.
- Real isolated public-source gate downloaded and hash-verified:
  Internet Archive MP4 66,520,877 bytes
  (`a7b618bd4605bc082327c391dd2ba047868cd8c4f387502616e7b7162b9ce036`),
  NASA MP3 39,477,902 bytes
  (`15f73cc5381c091e010a47841e10e928f7ca89fc39c047c9f7f65d7f6aff786b`),
  Wikimedia OGG 13,088,133 bytes
  (`36feea00f9a2150d9097da4c3be099cb8fcb2c259edb14534e0eaaf9cfafb846`),
  and LibriVox MP3 9,436,391 bytes
  (`9d65f34e7cac8d22951136949f347a59fb7f198657bb09305f46e40f13f55458`).
- Vite passed with 50 transformed modules and entry
  `assets/index-CLdw56k2.js`. Clean PyInstaller packaging passed.
- Rebuilt EXE size is 18,467,345 bytes; SHA-256 is
  `6D0CA2790D1E6340916DE08904B0BC58729AF93F464E77B8E80082BE37934E65`.
- Packaged authenticated smoke used an isolated portable root and downloaded
  the real Wikimedia sample through register → start → poll → publish. It
  completed at exactly 13,088,133 bytes with the expected OGG magic and SHA-256,
  then authenticated shutdown exited cleanly. The temporary root was removed;
  the user's downloads were untouched.
- `git diff --check` found no whitespace errors, only repository line-ending
  notices.

### Independent direct-code self-audit

```text
adapter finite URL -> authenticated registration -> opaque media ID
                                                   |
POST jobs/download (ID only) -> registration lookup -> JobRegistry limits
                                                   |
pinned connector -> status/type/length/validator -> exclusive .part
                                                   |
safe retry -> validated Range/If-Range or restart -> bytes/progress/fsync
                                                   |
finalizing -> exclusive final reservation -> atomic replace -> completed path

cancel/shutdown -> event + upstream close -> worker join -> partial cleanup
open folder     -> fixed validated portable downloads root -> os.startfile
```

The first cancellation smoke exposed that registry cancellation could become
visible before the worker closed its `.part` handle. The controller now joins
cleanup, and the worker defers the terminal cancellation transition to the
registry. That repair exposed a second gap: a transfer exception before
`_transfer` returned left the outer worker without its partial path. Per-job
partial ownership is now registered at reservation and removed in every exit.

The independent audit then corrected misleading initial 0% for unknown totals,
premature output-path exposure, empty-file publication, weak ETag resume,
unchecked Content-Range totals, downloads-root junction traversal, unexpected
worker exception handling, route-matrix drift, duplicate detection across new
opaque registrations, and shutdown waiting on an idle socket. Focused tests
were added for every correction before the complete real/full/build/package
sequence was restarted.

The final post-package pass mapped registration fields, both fixed routes, job
limits/transitions, connector redirects and headers, every retry branch,
collision and cleanup ownership, runtime-root derivation, cache separation,
shutdown reachability, frontend opaque exchange, and packaged inclusion.
Searches found no FFmpeg import/invocation, shell execution, frontend-controlled
filesystem path, raw download URL on the start route, or cache-to-filesystem
deletion connection. No further Phase 6 gap was found.

Final Phase 6 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 7 — Live recording and finalization

Status: complete
Completed: 2026-07-11

### Implementation evidence

- Added `worldmedia_recording.py` with pure, fixed FFmpeg/ffprobe argument
  builders. Inputs must be opaque localhost relay URLs; profile names are an
  exact enum; browser URLs, paths, commands, argument lists, and codec settings
  never reach process construction.
- Compact, Balanced, and High are fixed at 96/160/256 kbps MP3. Video uses
  480/720/1080 maximum height, CRF 27/23/20, AAC 96/160/192 kbps, H.264
  `veryfast`, even no-upscale dimensions, `yuv420p`, and two-second forced
  keyframes.
- Input probing is bounded and classifies actual streams. If source probing
  finds audio beside video, mapping and both pre/post-remux validation require
  AAC; silent video remains supported. Output validation rejects missing/zero
  duration, wrong codecs, odd or oversized dimensions, and malformed metadata.
- Audio records to a hidden working MP3. Video records to fragmented MP4 with
  an empty initialization moov and keyframe fragments, validates the working
  file, remuxes by stream copy to normal fast-start MP4, validates again, then
  publishes by exclusive reservation and atomic replacement.
- Recording startup uses FFmpeg progress plus authoritative file size. Audio
  requires a full encoded second; video requires both a real frame and encoded
  time, preventing a 28-byte MP4 header from being reported as a running
  recording. Bytes and elapsed time remain globally visible through job state.
- Main encoding and every probe/remux child run hidden with `shell=False`.
  stdout progress and bounded/redacted stderr are drained concurrently. Stop
  writes `q`, waits, escalates to terminate and kill only on timeout, and still
  validates a forced-stop fragmented output before publication.
- The registry enforces one active recording, monotonic states, idempotent
  registry-level Stop, global authenticated job visibility, and independence
  from player pause/item ownership. A failed process always reaches a terminal
  job error and cannot remain reported as recording.
- Recoverable working files use exclusive collision-safe names, including
  multiple failures in the same second. Final/recovery paths are derived only
  under the validated app-adjacent downloads root and never overwrite an
  existing file.
- Recorder shutdown owns its workers, controllers, main FFmpeg processes, and
  probe/remux children. It attempts graceful finalization, then synchronously
  terminates/kills and reaps every child before relay invalidation. The shutdown
  endpoint refuses to exit with a retryable 503 if safe cleanup is incomplete.

### Smoke-test evidence

- Focused recording suites: 14/14 passed. Coverage includes exact vectors and
  injection rejection, all profiles, progress startup gates, output codecs and
  dimensions, early exits, stop/cancel races, ignored `q`, forced termination,
  interrupted fragmented MP4 recovery, same-second recoverable collisions,
  5,000-line stderr flood/redaction, hung probe/finalizer reaping, and complete
  service shutdown.
- Local real-FFmpeg matrix passed: three MP3 bitrates, three H.264/AAC MP4
  quality ceilings, normal finalization/remux, and killed fragmented-MP4
  recovery. ffprobe verified every container, stream, duration, bitrate, and
  dimension invariant.
- Final application regressions passed after audit repairs: JavaScript 37/37
  and Python 69/69, including control API, relay security/ranges, downloads,
  FFmpeg management, runtime paths, state machines, and server shutdown.
- Current public-source gate used maintained Radio Browser and iptv-org data
  with production DNS/redirect policy and opaque relay registration. Radio
  Browser produced a 346,604-byte, 17.304-second, 160 kbps MP3. iptv-org
  produced a 2,647,374-byte, 9.640-second H.264/AAC MP4. Both stopped cleanly,
  passed ffprobe, and opened successfully through Windows WPF `MediaPlayer`.
- Vite passed with 50 transformed modules and entry
  `assets/index-CLdw56k2.js`. A clean PyInstaller one-file build passed.
- Final EXE is 18,489,461 bytes with SHA-256
  `6C7DF67786F8BD7BE0E05EBC515237C0BB37C61A3CF202EE11F3CE45C3A35D31`.
- Final packaged authenticated smoke used an isolated portable root and a
  current Radio Browser station. Register → record → stop → finalize produced
  a 329,186-byte, 16.431-second MP3; authenticated shutdown returned 202 and
  the EXE exited. No FFmpeg/ffprobe process or test listener remained.
- All affected Python modules compiled. `git diff --check` found no whitespace
  errors, only existing line-ending notices.

### Independent direct-code self-audit

```text
live adapter URL + headers -> authenticated registration -> opaque media ID
                                                        |
POST jobs/record (ID/profile) -> backend probe -> fixed audio/video vector
                                                        |
local relay -> reconnect/timeouts -> progress + bounded stderr -> working file
                                                        |
Stop q -> bounded escalation -> validate -> MP4 remux/validate -> atomic final

failure -> exclusive recoverable artifact -> terminal safe job error
shutdown -> stop/cancel -> tracked main + utility children -> reap -> relay clear
```

The initial real-video smoke found four connected defects that synthetic
processes did not expose: `reconnect_at_eof` could loop finite fixture input;
ffprobe/HLS reloads needed non-seekable input and a narrowly allowed zero-range
manifest probe; fragmented MP4 could encode media while reporting only its
28-byte header; and a dead static HLS fixture did not model advancing live media.
The recorder and relay were corrected, and the test server now publishes a
deterministic rolling playlist.

The separate post-smoke audit then found and repaired two further gaps. First,
shutdown tracked the main encoder but not probe/remux children created by
`subprocess.run`, which could theoretically survive forced app exit. All
utility processes are now explicitly tracked, terminated/killed, and reaped;
shutdown refuses to exit if cleanup is incomplete. Second, recoverable naming
was a check-then-replace single timestamp that could lose a second failure.
Recovery publication is now exclusive, collision-looped, root-confined, and
race tolerant. Dedicated regressions were added before the full suite, real
sources, build, and packaged gates were repeated.

The final connection review mapped all registration fields, exact start/stop/
cancel/status routes, job limits and transitions, source-audio preservation,
relay scoping and redirects, process arguments, progress/thread ownership,
working/final/recoverable files, atomic publication, failure state, shutdown
ordering, packaged inclusion, and user-visible global status. Searches and
direct review found no remote command input, shell execution, browser-selected
path, unbounded stderr/history, raw URL on the start route, overwrite race, or
orphan child path. No further Phase 7 gap was found.

Final Phase 7 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

## Phase 8 — Player bar, Settings, progress, and accessibility

Status: implementation, automated smoke, packaged smoke, and independent
direct-code audit complete. The manual keyboard/screen-reader exit check remains
open because Windows Graphics Capture could not observe the native pywebview
window; no blind input was sent.

### Implementation

- Added a pure capture view model covering download, record, stop, checking,
  installing, downloading, finalizing, completed, failed/cancelled, and
  unavailable states. Active recording is global; downloads retain item
  identity and background counts.
- Added authenticated all-job synchronization with adaptive foreground/hidden
  polling, stale-response rejection, item/mode/focus refresh, exact stop/cancel/
  retry/open-folder recovery, and install-cancel generation guards.
- The player now has distinct capture, secondary, EQ, status, progress, and
  throttled live-announcement regions. Capture state never overwrites title or
  source. Active capture remains controllable in capture-only mode after player
  Stop, and disappears only after terminal completion.
- Added EQ active/bypassed indication using the effective global/favorite curve.
  The button emits the Phase 10 overlay event without prematurely implementing
  the Phase 9 audio graph.
- Settings now exposes immediate recording quality, exact portable/downloads/
  tools paths, writability, Open downloads, and the complete FFmpeg status,
  destination, install, repair, cancel, remove, provider, digest, and license
  disclosure workflow.
- Added modal focus trapping, Escape/restore behavior, background inertness,
  explicit labels, focus-visible styling, reduced motion, progress ARIA, mute
  pressed state, and stable tool-state announcements.
- Added an explicit multi-row player layout at 1000 px and below. This covers
  the native window's supported 980 px minimum with labels visible and removes
  the prior tight single-row width budget.
- Backend job snapshots now carry bounded `item_id` through download/record
  creation, the list endpoint, schemas, fixtures, and frontend association.

### Smoke-test evidence

- JavaScript: 44/44 passed, including every backend/view state, cross-item and
  mode polling, capture-only behavior, settings migration, ARIA/DOM contracts,
  live-message isolation, and the 1000 px compact-layout baseline.
- Python: 69/69 passed across control/security APIs, runtime paths, jobs,
  downloads, FFmpeg management, relay, recording, finalization, and shutdown.
- Vite production build passed with 54 modules. Final entry assets are
  `assets/index-C-cFFhrm.js` and `assets/index-nvig1u4F.css`.
- Clean PyInstaller one-file build passed. Final EXE is 18,496,079 bytes with
  SHA-256 `284F72D36DC820B8E5D38087C4012BE5B2A4954704FF5F9F28AA665819DE5C8F`.
- Final isolated packaged smoke verified health, all static player markers,
  current bundle markers, PATH FFmpeg discovery, and authenticated job/item
  synchronization. A stable public MP3 stream recorded, stopped, finalized,
  and ffprobed as a 329,186-byte, 16.431-second MP3.
- Packaged shutdown returned 202; zero app/FFmpeg processes and zero listeners
  remained. The verified temporary portable root was removed.
- `git diff --check` found no whitespace errors, only repository line-ending
  notices.

### Independent direct-code self-audit

```text
normalized item -> capability -> pure capture view -> player action/status/ARIA
       |                                  ^                  |
       `-> opaque registration -> job item_id -> jobs poll --'

record request -> tool status -> explicit install confirmation -> resume once
      |                 |                    |
      `-> stop/cancel <- generation/AbortController <- cancel/item switch

settings open -> app inert -> focus trap -> immediate persistence/status poll
settings close -> disposed guard -> no late render, timer restart, or focus loss
```

The separate post-smoke review found and repaired seven integration gaps:
playback Stop could hide an active recording; a cancelled FFmpeg install could
resume later; a no-current-item download boundary was null-unsafe; elapsed-time
polling could chatter through a live region; generic retry could perform the
wrong recovery action; stale polls could overwrite newer state; and same-item
emissions could abort a valid install. Dedicated state handling and regressions
were added for each connection.

The final audit then found two additional issues after the first packaged pass.
A pending Settings request could resolve after close and restart its polling
timer, so all late async renders/actions now honor a disposed guard. The 980 px
minimum window also had only a narrow calculated margin in the five-column
layout, so the tested multi-row layout now begins at 1000 px. A null-item error
scope comparison was normalized at the same boundary. All suites, the build,
and the real packaged recording gate were repeated after these repairs.

Windows Computer Use launched the native application, but its observation call
failed with `SetIsBorderRequired ... 0x80004002`. In accordance with the tool's
safety rules, no blind keyboard or mouse input followed. User testing separately
confirmed the corrected autoplay/play/pause control behavior. The remaining
manual checklist is: visible focus order through player capture/EQ controls,
Settings focus trap/Escape restoration, and one screen-reader pass confirming
state announcements are useful and non-repetitive.

Current Phase 8 rating: implementation 10/10; automated and packaged smoke
10/10; independent self-audit 10/10. Phase exit remains pending only the
explicit manual keyboard/screen-reader record.

### User-reported Phase 8 navigation regression repair

The user's live-app check clarified that “sidebar” meant the right-hand media
details panel, not the left source list. Selecting media opened the panel, but
Library → Tuner → Library discarded it even though playback correctly remained
global. The Library teardown removed both the detached panel DOM and its
selection identity.

- Added session-level `detailItemId`; opening details records it, explicit Close
  clears it, and navigation teardown removes only stale DOM while preserving
  identity.
- Returning to Library resolves the current selected item first, then the
  Library/favorite pool fallback, and rebuilds the details panel.
- Connected Library teardown directly to `mode-change`, so subscriptions,
  thumbnail/infinite observers, and detached-DOM work stop immediately when
  another tab opens rather than lingering until a later Library mount.
- Added two behavioral lifecycle tests plus a source connection contract.

Post-repair evidence: JavaScript 47/47, Python 69/69, Vite 54 modules, and
`git diff --check` passed. A clean PyInstaller build and isolated packaged smoke
served `assets/index-CIXp9PET.js`, verified all lifecycle markers, returned
shutdown 202, and left zero processes/listeners. The resulting EXE is
18,497,303 bytes with SHA-256
`4BE3550B1913403CCC5F80300342A6E048D5F2E0351353506B76FFEEB2F10EC3`.

Independent audit mapping:

```text
open details -> detailItemId -> leave Library -> immediate observer/sub cleanup
                                      |            + remove detached panel DOM
                                      `-> enter Library -> resolve current item
                                                        -> rebuild detail panel

explicit Close -> clear detailItemId -> later Library mount stays closed
```

### Phase 8 owner acceptance

The owner retested the rebuilt EXE and supplied before/after screenshots of a
live radio recording and its completed/Open folder state. The screenshots show
the selected card, restored right-hand details panel after tab navigation,
global player bar, Stop recording state, elapsed/byte status, completed state,
Record again recovery, EQ indication, and unclipped layout. The owner confirmed
the details-panel regression is fixed and accepted the phase. Narrator was
clarified as an accessibility-only QA aid rather than an ordinary-use
requirement; keyboard/ARIA/live-region semantics remain covered by the frozen
DOM contract and state-transition tests.

Final Phase 8 rating: implementation 10/10; smoke testing 10/10; independent
self-audit 10/10; owner manual acceptance complete.

### Post-acceptance Shutdown regression repair

The owner reported that the red Shutdown button no longer terminated the app
fully. Direct mapping found the frontend still used the pre-security bodyless
POST. The secured backend requires the per-launch token, exact same origin,
JSON content type, and `{}` body; it rejected the button's request, after which
the frontend attempted to close only the visible window.

- Shutdown now uses the shared authenticated control client and sends the exact
  allowed JSON mutation.
- One five-second abort signal covers both token acquisition and the shutdown
  request.
- The UI closes only after backend acceptance. A 503, timeout, or auth failure
  keeps the app open, resets the guard, and exposes a visible Retry shutdown
  action with the safe backend message.
- Added focused acceptance/rejection tests proving token, JSON body, signal
  propagation, close-after-202, and no-close-on-error behavior.

Independent audit mapping:

```text
Shutdown click -> timed session token -> authenticated JSON POST -> 202
                                                           |
                                                           `-> process exit

token/cleanup/timeout failure -> no window close -> Retry shutdown -> retryable
```

Post-audit evidence: JavaScript 49/49, Python 69/69, Vite 54 modules, and
`git diff --check` passed. The clean one-file package served
`assets/index-9qj11WiY.js`; the old unauthenticated request was rejected 403,
the corrected request returned 202, and zero processes/listeners remained.
The EXE is 18,496,558 bytes with SHA-256
`C7D416DD7F9636BB247563F72D09041748FB0BD3FADE3AA2E1BA103A0C516068`.

Owner acceptance: the rebuilt visible EXE was launched and the owner confirmed
the repaired red Shutdown button fully closed the application.

## Phase 9 — Web Audio equalizer engine

Status: complete. Implementation 10/10; smoke testing 10/10; independent
self-audit 10/10.

### Implementation

- Added one lazily created `AudioContext` shared by the permanent audio and
  video elements. A map enforces the Web Audio requirement that each media
  element receives at most one `MediaElementAudioSourceNode` for its lifetime.
- Built the approved graph: input, dry bypass, -12/+6 dB preamp, ten
  -12/+12 dB filters at 31–16000 Hz, safety compressor, wet gain, analyser,
  and destination. Parameter changes use 15 ms target smoothing.
- Bypass crossfades between exactly one dry and one wet path while preserving
  the stored curve. The response calculator provides deterministic local
  frequency-response data without requiring a live context.
- The player resumes Web Audio from Play/card/EQ gestures before asynchronous
  stream resolution, applies the global/favorite effective curve before media
  starts, and reuses the video source across direct video and HLS/MSE.
- Playback is processed only after the secured same-origin relay succeeds.
  Relay failure leaves an unattached element safe for direct playback, or
  visibly refuses unsafe direct playback after an element has already entered
  Web Audio, avoiding the browser's permanent cross-origin silence behavior.
- Analyser RMS monitoring distinguishes intentional mute/zero volume,
  pause/end, stale ownership, real signal, and sustained unexpected silence.
  The final audit added a monitor generation so repeated Play/EQ gestures
  cancel older checks rather than allowing overlapping delayed results.
- The bottom-bar EQ status now distinguishes Flat, Active, Bypassed,
  Suspended, and Unavailable with an accessible reason.

### Smoke-test evidence

- Focused EQ/player/capture regression: 15/15 passed before the audit repair;
  the final focused pass was 9/9 after stale-monitor cancellation was added.
- Full JavaScript suite: 56/56 passed.
- Full Python suite: 69/69 passed.
- Vite production build: 55 modules transformed successfully.
- `git diff --check`: no whitespace errors (only existing line-ending notices).
- The rapid-update benchmark completed 5,000 normalized, smoothed ten-band
  curve changes in about 69 ms in the final test run, under its 1,000 ms limit.
  Before playback the context factory was called zero times, so idle EQ creates
  no audio graph or processing load.
- A real browser diagnostic used cross-origin generated fixtures through opaque
  localhost relay IDs and the production engine. Relayed WAV audio, MP4 video,
  and HLS/MSE all produced analyser signal and ended normally; pause resumed;
  RMS was 0.093633; the response at 31/1000/16000 Hz was
  +4.135/-2.987/-3.000 dB; and source count remained exactly two. Direct video
  created the video source and HLS reused it (`sourceCreated: false`). The
  isolated servers and both listening ports were then stopped.

### Independent connection audit

```text
card/Play gesture -> resume lazy context -> register opaque relay -> attach media
                                                           |             |
effective scope -> preamp -> 10 filters -> compressor -> wet gain         |
                 `---------------- dry bypass ----------------------------+
                                                                        analyser
                                                                           |
                                                                      destination

new item / Stop -> playback generation invalidated -> stale media events ignored
                                                 `-> stale analyser check cancelled

audio element -> one source node for all radio/audio selections
video element -> one source node shared by MP4 and HLS/MSE selections
```

The audit found no dangling EQ, favorite-scope, player-control, relay, HLS, or
status connection. Phase 9 exit criteria are satisfied.

## Phase 10 — EQ overlay and automatic scope persistence

Status: implementation, automated smoke testing, and independent code audit
complete. The phase remains open only for audible A/B confirmation and one
actual native-app restart/reselection pass.

### Implementation

- Added an accessible modal EQ overlay with a preamp, ten vertical half-decibel
  sliders, live dB outputs, bypass, reset, response graph, keyboard-native range
  controls, focus trap, Escape/backdrop close, focus restoration, and compact
  horizontal scrolling.
- Added immutable Flat, Bass Boost, Treble Boost, Vocal, Spoken Word, Rock,
  Classical, Jazz, Electronic, and Night templates. Every boosted template
  reserves matching preamp headroom.
- Slider and preset changes update the live audio engine immediately, while the
  current scope persists after a 150 ms debounce with no Apply or Save action.
  A preview event keeps the bottom EQ state synchronized during that debounce.
- Added custom preset creation, automatic rename, automatic selected-template
  updates, and deletion that retains the current curve snapshot.
- The overlay prominently identifies Global versus the favorite title and now
  includes Add/Remove favorite in the modal, so scope can change without
  breaking modal inertness or focus containment.
- Favorite transitions synchronously flush pending audible settings before
  cloning scope. The audit widened this to flush pending Global changes before
  any item is favorited, including nonstandard programmatic transitions.
- Persisted curves remain separate snapshots. Editing or deleting a named
  custom template cannot silently alter another favorite.
- Normalization clamps every preamp/band before AudioParams and treats hostile
  favorite map keys as data while rejecting unsafe custom-preset keys.

### Smoke-test evidence

- Focused EQ/overlay/store/capture/player/contract suites passed after each
  repair; the final focused persistence/contract pass was 17/17.
- Full application regression: JavaScript 62/62 and Python 69/69 passed.
- Vite production build transformed 57 modules successfully; `git diff --check`
  reported no whitespace errors.
- A real browser loaded the production modules and overlay, then passed 11
  sliders, immediate built-in selection, 150 ms autosave, two favorite scopes,
  two custom presets, rapid rename plus slider movement, favorite/unfavorite
  restoration, Escape and focus restoration, backdrop close, narrow horizontal
  scrolling, and the cache media/tool boundary. The isolated result reported
  `passed: true`, `sliders: 11`, `customPresets: 2`, `favoritesTested: 2`,
  `narrowScroll: true`, and `focusRestored: true`; its server was then stopped.

### Independent connection audit

```text
EQ button -> user-gesture context resume + open one modal -> effective curve
                                                        |-> immediate preview
                                                        `-> 150 ms scope commit

pending Global/favorite edit -> before-scope hook -> atomic storage flush
favorite add -> clone audible curve -> favorite title scope -> engine reapply
favorite remove -> delete item curve -> Global restore -> engine reapply

built-in selection -> immutable template -> current-scope snapshot
custom selection -> current-scope snapshot + selected-template auto-update
custom deletion -> remove template only -> retain current manual snapshot

close/Escape/backdrop -> flush pending -> remove listeners -> clear app inert
                                           `-> restore invoking control focus
```

The self-audit found and repaired four gaps after the first green test pass:
stale bottom-bar indication during debounce, custom-name loss when a slider was
moved in the same debounce window, inability to change favorite scope inside
the modal, and incomplete Global flushing before an unrelated favorite clone.
No unresolved implementation or automated-test gap remains.

### Phase 10 owner acceptance and final follow-up audit

The owner tested the restarted native source build, reported that EQ was
working, and supplied a screenshot of active processed playback. They also
identified two follow-up gaps during that acceptance pass:

- Moving only the preamp changed the preset selector to Manual. Preamp is now
  treated as an independent master/headroom adjustment and retains the selected
  built-in or custom frequency-preset identity. Frequency-band edits still
  detach immutable built-ins into a Manual snapshot; selected custom presets
  continue auto-updating.
- A legacy Internet Archive favorite played successfully but showed capture as
  Unavailable. Older favorite JSON could contain a resolved finite stream and
  `needsResolve: false` without the later `download_url` contract. A
  source-agnostic finite-media repair now runs during favorite migration,
  playback, and lazy-resolution persistence. It restores direct on-demand
  audio/video download metadata without misclassifying radio/live streams.

Independent connection audit:

```text
legacy favorite -> normalize -> finite direct/on-demand inference -> download_url
       |                                                       `-> persisted migration
       `-> Play -> runtime repair -> lazy resolve -> persist metadata -> Download UI

built-in curve -> preamp edit -> retain presetId + scope autosave
               `-> band edit -> Manual snapshot (template stays immutable)
```

Focused follow-up smoke passed 19/19. The full post-repair suite passed
JavaScript 63/63 and Python 69/69; Vite transformed 57 modules and
`git diff --check` found no whitespace error. Phase 10 final rating:
implementation 10/10, smoke testing 10/10, independent self-audit 10/10, owner
audible acceptance complete.

## Phase 11 resilience follow-up: deterministic shutdown

An intermittent native shutdown report was reproduced as a live process that
remained open without any `/api/shutdown` request reaching the backend. A
direct authenticated request proved the cleanup/exit path healthy and closed
that exact process in 118 ms, isolating the gap to frontend activation.

- Shutdown binding now happens immediately on `DOMContentLoaded`, before
  persisted state or source startup can delay the rest of application boot.
- Binding is idempotent and accepts both normal click and primary pointer-up,
  while the in-flight guard collapses the paired browser events into one
  request. Secondary/right-click is explicitly ignored.
- A stale local control token is refreshed and retried once within the same
  activation, removing the former second-click recovery behavior.
- The browser close fallback no longer assumes a global `window` binding.

The new focused shutdown suite passed 4/4, the complete JavaScript suite passed
65/65, the complete Python suite passed 69/69, Vite transformed 57 modules,
and `git diff --check` found no whitespace error. A rebuilt native source app
then received Ctrl+Q through Windows automation (the same request function as
the button), logged one HTTP 202 shutdown, exited within three seconds, released
its listener, and left no World Media or FFmpeg process behind. The actual
pointer/button path is independently covered by a regression that exercises
pointer-up plus the following click and proves exactly one shutdown POST.

## Phase 11 — Cross-source integration, resilience, and performance audit

Status: implementation, exhaustive smoke testing, and the independent
post-smoke code/security audit are complete.

### Cross-source and DASH implementation

- Added a lazy, one-instance dash.js 5.2.0 playback path. DASH is loaded only
  when a DASH item starts, requires Media Source Extensions, accepts only an
  opaque local relay URL, and destroys partial or stale players exactly once.
- Added a DNS-pinned DASH relay that parses bounded XML, rewrites static and
  templated MPD resources to opaque scoped capabilities, constrains every
  template substitution, supports representation-specific BaseURL trees, and
  re-resolves every expanded segment URL. Manifest telemetry, patches, content
  steering, external XLinks, entities, unsafe nesting/fan-out, and DRM are
  rejected explicitly.
- Corrected the legacy metadata proxy during the independent endpoint audit.
  It now enforces localhost Host/same-origin checks, one bounded query, a 64 KiB
  POST ceiling, pinned DNS across redirects, a strict HTTPS source allowlist,
  and bounded streamed responses. Foreign-origin and DNS-rebinding paths no
  longer reach an upstream.

### Live source-matrix evidence

One coherent opt-in run passed all 16 categories through the production relay:

```text
Radio Browser: HTTP MP3, HTTPS AAC, HLS AAC
iptv-org: HTTPS HLS, Referer HLS, User-Agent HLS, HTTP HLS, non-DRM DASH
Internet Archive: MP3 and H.264/AAC MP4
NASA: MP3 and H.264/AAC MP4 asset-manifest resolution
Wikimedia: OGG/Vorbis and WebM video
LibriVox: MP3 chapter and direct full-audiobook ZIP (PK signature)
```

The live DASH candidate exposed H.264 and AAC through rewritten MPD/static/
templated relay routes. A deliberately current broken IPTV candidate timed out
and the matrix continued to a working alternate, proving that an upstream
failure is evidence rather than a false app failure. Internet Archive also
failed transiently in one preliminary run, then passed through a bounded set of
independent derivatives. Cleanup measured zero retained media registrations or
DASH templates. Every logged media/DASH capability was rendered as
`/api/v1/.../<redacted>`.

The hardened metadata proxy separately returned valid live JSON from NASA,
Wikimedia, LibriVox, and Internet Archive.

### Resilience and resource evidence

- Download recovery tests cover interrupted bodies, stable Range/validator
  resume, changed-validator restart, cancellation, duplicate suppression,
  disk publication failure, filename races, and removal of partial/final
  placeholders.
- Relay tests cover slow consumers, upstream truncation, timeout, redirect
  pivot, header-dependent sources, client disconnect, token expiry, manifest
  size/child/representation limits, and 16 concurrent relay slots.
- Recording tests cover reconnect arguments, early failure, interrupted
  fragmented MP4 recovery, graceful stop/finalization, hung probe/remux kill,
  bounded stderr, and child-process reaping. The owner also completed a real
  45-second recording while changing app views; playback/capture remained in
  the global bottom bar.
- Mode/focus/suspend-equivalent state changes are isolated from capture jobs:
  rapid player generation changes ignore stale events, Library teardown keeps
  the selected identity, capture polling remains attached to the media item,
  and backend work uses monotonic deadlines plus FFmpeg reconnect behavior.
- Portable-root probes, denied writes, failed atomic replacement, read-only
  tool destinations, staging cleanup, and explicit LocalAppData FFmpeg
  selection all return actionable states without publishing partial output.
- Job history/concurrency, stderr history, registry entries, per-manifest
  children, DASH representations/templates, request bodies, response bodies,
  relay slots, worker joins, and subprocess lifetimes have tested hard bounds.

The resource benchmark transferred 64 MiB through the relay at 60.51 MiB/s
with 0.372 MiB traced peak-memory growth. Local control p95 was 2.038 ms idle
and 2.808 ms during a real H.264/AAC FFmpeg recording. FFmpeg averaged 99.14%
of one logical CPU (8.26% normalized across this machine) and peaked at 197.4%
(16.45% normalized). The current EQ pass completed 5,000 smoothed ten-band
updates in 60.09 ms under the 1,000 ms limit and creates zero contexts while
idle.

### Independent post-smoke audit

```text
browser metadata request -> same-origin check -> bounded URL/body
                         -> pinned DNS + allowlist on every redirect -> stream cap

media registration -> opaque root -> HLS child / DASH template capability
                                  -> constrained segment expansion -> DNS recheck

Shutdown -> recording finalize/reap -> cancel jobs -> download worker reap
         -> FFmpeg install cleanup -> clear media registry -> accept process exit
```

The audit found and repaired two gaps after green functional tests:

1. FFmpeg installation cleanup was not part of the boolean shutdown result,
   and each service received a fresh timeout. Shutdown now uses one shared
   deadline and refuses exit unless recording, download, FFmpeg, and job owners
   all confirm cleanup.
2. The older metadata proxy checked DNS separately from its network connection
   and accepted an unbounded POST. It now uses the pinned connector and the
   same-origin/body limits described above.

Focused repairs passed 30 shutdown/download/FFmpeg tests and 24 proxy/media
tests. The final normal-order suites passed JavaScript 68/68 and Python 77/77;
the reversed file/module order repeated at 68/68 and 77/77. After the final
registry-bound regression, the focused media security suite passed 11/11.
Vite 8.1.4 transformed 59 modules, npm reported zero vulnerabilities, and
`git diff --check` reported no whitespace errors. No high/critical endpoint,
orphan worker/process/file, or unbounded resource defect remains. Phase 11 is
rated implementation 10/10, smoke testing 10/10, independent audit 10/10.

## Phase 12 packaging and release audit (in progress)

### Antivirus-safe portable packaging repair

Freshly generated unsigned PyInstaller 6.21 and 6.20 launchers were
quarantined at execution by Malwarebytes generic AI/heuristic detections. The
same behavior reproduced with one-file, one-folder, windowed, console, pruned,
and minimal-payload variants; source startup remained healthy. No antivirus
setting, exclusion, or quarantine rule was changed.

The release builder now uses Python's official x64 3.13.14 embedded
distribution from `python.org`, pinned to SHA-256
`90B4E5B9898B72D744650524BFF92377C367F44BD5FBD09E3148656C080AD907`.
Its unmodified PSF-signed `pythonw.exe` is the portable
`WorldMediaWindows.exe`; Authenticode verification reports `Valid`. A
restricted `python313._pth` admits only the bundled standard library, app root,
and pinned site-packages. `sitecustomize.py` enters `worldmedia_native.main()`.
The runtime packages and their full transitive set are exact-version pinned,
recorded in `BUILD_MANIFEST.json`, and unused Android/ARM64/x86 payloads are
removed. Four focused packaging tests cover provenance, pins, pruning, and
isolation.

The final ZIP is:

```text
dist\WorldMediaWindows-0.1.2-portable.zip
SHA-256 D6035A27DF53B782AC92F77A3BEA5A8A1E9DF943B325D4756CC4AA24974A3721
```

Archive inspection found all frontend/DASH/HLS/WinForms/Edge WebView assets and
416 total entries. It found no downloads, tools, state, logs, tests, build
cache, managed FFmpeg, Android JAR, ARM64 loader, or x86 loader. The packaged
third-party notice names Python 3.13.14 and every bundled runtime dependency;
their installed license files remain in the corresponding `*.dist-info`
directories.

### Clean gates and packaged smoke

- `npm ci`: 39 packages audited, 0 vulnerabilities.
- JavaScript: 69/69 normal order and 69/69 reversed order.
- Python: 85/85 normal order and 85/85 reversed order.
- Vite 8.1.4: 59 modules transformed; DASH remains a lazy production chunk.
- A new Python virtual environment installed the current
  `requirements-build.txt` and built the final portable folder/ZIP.
- The release ZIP was extracted to a fresh writable directory. The signed EXE
  served health, app shell, session, runtime, and third-party notices; the
  control token was 64 characters and authenticated shutdown returned 202.
  Exit left zero listeners, child processes, partial/finalizing files, and
  executable locks.

### Independent post-smoke package audit

```text
official signed launcher -> isolated python313._pth -> sitecustomize
                         -> worldmedia_native.main -> local server/WebView2

app root -> frontend/assets + app modules
         -> adjacent downloads/ and managed tools/ (created only at runtime)

shutdown POST -> all worker-owner cleanup -> server close -> interpreter exit
```

The audit found two release-only issues after green backend smoke: the obsolete
generated launcher still triggered the installed antivirus, and a signed
launcher would otherwise inherit Python's icon. The first caused the signed
embedded-runtime design above; the second is handled by passing the bundled
World Media ICO directly to pywebview's WinForms window, with a frozen contract
test. The diff has no whitespace errors. The automated/package portion of
Phase 12 is complete; final native visual interaction remains pending because
the Windows Computer Use native pipe was unavailable after its required retry
and reset sequence.

### Public output and final-package functional evidence

The opt-in public recording matrix now runs every quality profile and retains
the complete ffprobe result. All six outputs also opened through Windows Media
Foundation:

| Profile | MP3 result | H.264/AAC MP4 result |
|---|---|---|
| Compact | 207,980 bytes; 17.304 s; 96 kbps | 1,389,173 bytes; 9.720 s; 852x480; ~1.11 Mbps video; ~95 kbps AAC |
| Balanced | 346,604 bytes; 17.304 s; 160 kbps | 1,925,397 bytes; 10.488 s; 1280x720; ~1.38 Mbps video; ~155 kbps AAC |
| High | 554,540 bytes; 17.304 s; 256 kbps | 2,616,471 bytes; 9.720 s; 1280x720; ~2.10 Mbps video; ~186 kbps AAC |

High correctly retained the 720p source instead of upscaling it to 1080p.
The finite-original public matrix completed atomically with these SHA-256
results and no `.part` file:

- Internet Archive MP4: 66,520,877 bytes,
  `a7b618bd4605bc082327c391dd2ba047868cd8c4f387502616e7b7162b9ce036`.
- NASA MP3: 39,477,902 bytes,
  `15f73cc5381c091e010a47841e10e928f7ca89fc39c047c9f7f65d7f6aff786b`.
- Wikimedia OGG: 13,088,133 bytes,
  `36feea00f9a2150d9097da4c3be099cb8fcb2c259edb14534e0eaaf9cfafb846`.
- LibriVox MP3: 9,436,391 bytes,
  `9d65f34e7cac8d22951136949f347a59fb7f198657bb09305f46e40f13f55458`.

The final ZIP was then extracted with system FFmpeg deliberately removed from
its child environment. It reported `missing`, accepted the explicitly
confirmed portable installation, and verified/activated
`ffmpeg-n8.1-latest-win64-gpl-8.1.zip` (167,400,009 bytes) from release
352526799. The GitHub digest and locally streamed digest both equaled
`sha256:d763cf870bae4ff0a92aafa92a686085b881f17013873cef9027e1474b2ba650`;
`SOURCE.txt`, `manifest.json`, `current.json`, and license material were all
present. Through that managed toolchain the packaged app downloaded the same
9,436,391-byte LibriVox original, recorded a 17.304-second 160 kbps MP3, and
recorded a 13.466-second 1280x720 H.264/AAC MP4. Both recordings passed ffprobe
and Windows Media Foundation. Authenticated shutdown exited code 0 with no
partials or listener. A separate final-ZIP run discovered the capable system
toolchain as `PATH` (44 protocols, 360 demuxers, 526 decoders, 221 encoders,
178 muxers) and also exited cleanly.

### Independent functional follow-up audit

The real packaged gate found two defects that unit/older-system tests did not:

1. Antivirus scanning could hold a newly probed FFmpeg staging directory
   longer than the original activation retry window. Activation now waits up
   to 45 seconds on a monotonic deadline, remains immediately cancellable, and
   still fails safely/retryably without changing `current.json`.
2. FFmpeg 8.1 rejects extensionless HLS child capabilities through its
   `allowed_segment_extensions` hardening. HLS and static/templated DASH
   rewrites now add only a decorative allowlisted suffix (`.m3u8`, `.ts`,
   `.m4s`, `.mp4`, and related media forms) after the opaque token. The server
   accepts only that fixed suffix set; `.exe` is rejected; upstream hosts,
   paths, queries, and headers remain absent. Managed FFprobe then reported the
   same H.264/AAC stream set directly and through the relay.

Focused scanner, HLS, DASH, suffix-rejection, and FFprobe-shape regressions
passed before the complete 69/69 JavaScript and 85/85 Python suites were run in
both normal and reversed order. The functional implementation/package/security
portion of Phase 12 is now 10/10; the exact final desktop visual/EQ persistence
check remains the sole user-visible gate.

The alternate-path audit also proves that a corrupt managed `current.json`
cannot escape its root and is ignored, a denied portable tools root returns
`DESTINATION_NOT_WRITABLE`, and only an explicitly selected LocalAppData
fallback installs there. Offline adapter failures retain their cursors and
recover without resetting settings; corrupt/legacy/future 0.1.2 storage keeps
valid favorites, volume/settings extensions, and global/favorite EQ state.
Shutdown-during-install, download, record, hung probe, and finalization paths
all have owner/reap assertions.

### Final owner shutdown confirmation

On 2026-07-11 the owner launched the then-current portable desktop release
candidate, exercised the Shutdown button, and confirmed that it closed the app
successfully. A final
post-confirmation audit reran the relay, FFmpeg, recording, and runtime-security
regressions (50/50 passed), reverified the PSF launcher signature as `Valid`,
and rehashed the unchanged release ZIP as
`DAD0CE00758A183760DC255EBED72CC4C0D3E5957A2FAA7857F8DC543C20BBE6`.
The 416-entry archive contained no downloads, tools, state, logs, tests,
managed-tool pointer, cache directory, or partial output.

### Pending-EQ shutdown follow-up and final rebuild

The final persistence audit found that EQ slider and custom-name writes used a
150 ms debounce. Closing the overlay flushed that pending edit, and the Shutdown
flow normally remained alive for another 250 ms, but Shutdown did not make the
ordering an invariant. A sufficiently abrupt WebView exit could therefore lose
the last automatic edit.

The overlay now exposes a synchronous pending-write flush. Shutdown invokes it
before its first session/control request, and `pagehide` invokes the same path
for ordinary window teardown. The write remains scoped through the existing
normalized Global/favorite/custom-preset store; no media URL, control token, or
backend data enters localStorage. Focused EQ/shutdown tests passed 21/21 and
prove `flush EQ -> acquire session -> authenticated shutdown`. Both complete
suites then passed again in normal and reversed order: JavaScript 69/69 and
Python 85/85. The independent connection audit was:

```text
slider/name input -> live preview -> pending normalized scope
                                  -> 150 ms autosave
Shutdown/pagehide -> synchronous flush -> localStorage
Shutdown          -> session/token -> backend cleanup -> 202 -> window close
```

Vite rebuilt 59 modules. The signed portable release was rebuilt and its
current SHA-256 is
`D6035A27DF53B782AC92F77A3BEA5A8A1E9DF943B325D4756CC4AA24974A3721`.
The packaged minified bundle contains both the `pagehide` binding and shutdown
path. Headless package smoke returned health/root 200, a 64-character session
token, authenticated shutdown 202, exit code 0, and zero listeners. The PSF
signature remains `Valid`; the 416-entry ZIP again contains zero runtime/user
data or partial files.

The managed integration matrix was then repeated against this exact
`D6035A27...74A3721` ZIP, extracted to a new temporary directory with system
FFmpeg removed from its child `PATH`. It verified and activated
`ffmpeg-n8.1-latest-win64-gpl-8.1.zip` with digest
`sha256:d763cf870bae4ff0a92aafa92a686085b881f17013873cef9027e1474b2ba650`.
The production relay exposed the same H.264/AAC HLS stream set as the direct
source. The package downloaded a 9,436,391-byte LibriVox original with SHA-256
`9d65f34e7cac8d22951136949f347a59fb7f198657bb09305f46e40f13f55458`,
recorded a 346,605-byte 17.304-second 160 kbps MP3, and recorded a
3,142,380-byte 17.783-second 1280x720 H.264/AAC MP4. Both recordings opened
through Windows Media Foundation and passed ffprobe. Final shutdown exited 0,
released the listener, and left zero partials.

### Owner-preferred classic one-file release restored

The owner explicitly selected the original distribution layout and added the
usual `dist` directory to their local Malwarebytes exclusion. The current app
was therefore rebuilt—not copied from the obsolete candidate—as:

```text
dist\WorldMediaWindows.exe
size 18,863,905 bytes
SHA-256 09E5ADE1F5F6F4B5ADB5A31535086568840A6FE94B731124BE55AA90B1685FAC
Authenticode: NotSigned (expected for this local PyInstaller artifact)
```

`build_single_exe.py` now reproducibly generates the classic artifact with
PyInstaller 6.21.0 and fully pinned transitive build dependencies. It disables
UPX, includes the current built frontend and notices, includes the ICO required
by the native WebView window, and collects the current WinForms/EdgeChromium,
pythonnet, and clr_loader runtime. The signed-runtime portable folder and ZIP
remain intact as a fallback; their ZIP hash remains
`D6035A27DF53B782AC92F77A3BEA5A8A1E9DF943B325D4756CC4AA24974A3721`.

The exact one-file EXE passed an isolated cold-start smoke in 4.108 seconds:
health and frontend 200, third-party notices 200, 64-character control token,
the requested temporary portable root, authenticated shutdown 202, exit code
0, zero listeners/processes/partials, and zero new `_MEI` extraction folders.
A recursive CArchive/PYZ audit found every `worldmedia_*` backend owner and
security module, WinForms and EdgeChromium modules, WebView2 loaders, frontend,
notices, and icon. PyInstaller's warning report contained only conditional
non-Windows/optional providers; the selected Windows imports executed in the
artifact smoke.

The dedicated real-artifact gate then executed that same EXE from its
whitelisted path with isolated state/download/tool roots. It discovered the
capable system FFmpeg, proved identical direct and relayed H.264/AAC HLS stream
sets, downloaded the 9,436,391-byte LibriVox original with SHA-256
`9d65f34e7cac8d22951136949f347a59fb7f198657bb09305f46e40f13f55458`,
recorded a 346,604-byte 17.304-second 160 kbps MP3, and recorded a
1,810,326-byte 12.766-second 1280x720 H.264/AAC MP4. Both recordings passed
ffprobe and opened through Windows Media Foundation. Shutdown exited 0 and left
zero listener or partial output.

One normal-order test run exposed an eight-second synthetic live-HLS fixture
that could finish while its input probe was slowed by immediate post-build
antivirus/disk activity. The recorder correctly rejected its 28-byte empty MP4;
the test source, unlike a real live channel, had simply stopped publishing. The
fixture now publishes 20 seconds/at least 12 segments. The failing test passed
three isolated repetitions before the change, passed the expanded focused gate,
and the complete Python suite then passed 87/87 in both normal and reversed
orders. JavaScript remains 69/69 in both orders.

Independent connection audit:

```text
current source + frontend + icon -> pinned PyInstaller spec -> one-file EXE
one-file parent -> _MEI child runtime -> native server/WebView2 -> current modules
portable_root override/default EXE directory -> downloads + managed tools
Shutdown -> all job owners -> local server close -> child/parent exit -> _MEI cleanup
```

No production defect was found in this follow-up. The classic artifact is rated
implementation 10/10, smoke testing 10/10, and independent artifact/code audit
10/10. The overall Phase 12 visual EQ-restart/DASH acceptance gate remains
separate and open.

The prior folder-build desktop window was then closed through its normal Windows
close message so the `pagehide` persistence hook could run. The classic
`dist\WorldMediaWindows.exe` was launched normally, became healthy on the usual
port 9124, and retained the established LocalAppData WebView2 storage location.

## 2026-07-13 — IPTV playback, capture, and EQ repair

The owner reported that DanceTV Minimal Tech could take a long time to start,
then stop with Try next while capture remained on Checking and EQ showed
Unavailable. Direct inspection of the current iptv-org entry identified the
master playlist at `mbit1.worldcast.tv`, containing 1080p, 720p, and audio-only
renditions.

The recording root cause was reproduced against that exact source. FFprobe on
the relayed master attempted every rendition and exceeded the former 12-second
probe budget. Recording now carries the normalized audio/video kind through the
opaque registration, selects one profile-appropriate HLS child before starting
FFmpeg, uses bounded demux analysis, skips the redundant input FFprobe for new
clients, and retains an independently probed final output. Legacy clients still
use input discovery. Startup remains cancellable and has a 45-second ceiling
for transient live-segment gaps.

The playback path now caps HLS adaptation to the player size and adds bounded
fatal recovery: two delayed network restarts, two media-pipeline recoveries,
duplicate-error coalescing, a recovery watchdog, a 30-second stable reset, and
complete cancellation on source switch/stop. A dead channel still terminates
with Try next. Relayed media explicitly uses anonymous mode so Web Audio remains
origin-clean, and analyser verification resumes a WebView-suspended context at
the point delayed media actually begins.

The permanent Checking state was traced to old favorites saved before the
`delivery` contract. Their semantic radio/TV type is now applied before the
generic unknown-manifest branch, producing Record audio/video immediately.
Capture polling also shares one FFmpeg status request and does not re-probe a
known-ready toolchain every three seconds.

Exact live-source smoke:

```text
Source: DanceTV Minimal Tech (iptv-org)
Registration: 1.028 s
First observed recording startup: 26.505 s (origin segment timing varied)
Result: completed
Output: 1,418,656-byte MP4
ffprobe: 17.099 s, 1280x720 H.264 + AAC
SHA-256: D453060915F7F3F3009C2D86C4D10D87820820D0D8A9647722948EF6F9BDE3C5
Repeated relayed rendition opens: approximately 3–7 s
```

Final automated gates after the independent audit:

```text
JavaScript: 72/72 normal, 72/72 reversed
Python:     89/89 normal, 89/89 reversed
Focused Python after final HLS fallback/timeout audit: 14/14
Python syntax compilation: passed
git diff --check: passed (line-ending notices only)
```

The reversed Python gate exposed a fixture isolation issue: the deliberate
metadata rate-limit exhaustion case left the process-global limiter full for a
later independently-created fixture server. Relay setup now clears that test
state in the same manner as the control API fixture; both full suite orders pass.

Independent connection audit:

```text
legacy/current IPTV item -> live video capability -> Record video
IPTV URL + headers -> opaque same-origin HLS relay -> hls.js adaptive playback
fatal HLS event -> bounded owned recovery -> playing reset OR terminal Try next
same relayed video element -> one Web Audio source -> resumed EQ/analyser
record click -> cached FFmpeg readiness -> audio/video registration kind
HLS master -> bounded secure fetch -> selected profile rendition -> opaque child
opaque child -> FFmpeg encode -> MP4 remux -> ffprobe validation -> atomic publish
source switch/stop/shutdown -> recovery timers + relay + FFmpeg owners cancelled
```

The current frontend then rebuilt 60 modules and the owner-preferred classic
artifact was replaced in its usual whitelisted location:

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
size: 18,868,721 bytes
SHA-256: 0ACA32E1F6E2BBCDCA8C5FC401B1FB4FEE093202A4D6D652600EA0D9CA9F991E
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
```

The exact EXE passed its isolated real-artifact matrix in 50 seconds. It found
the capable PATH FFmpeg, proved identical direct/relayed HLS stream sets,
downloaded the known 9,436,391-byte LibriVox MP3 with SHA-256
`9d65f34e7cac8d22951136949f347a59fb7f198657bb09305f46e40f13f55458`,
recorded a 346,604-byte 17.304-second 160 kbps MP3, and recorded a
2,449,498-byte 15.985-second 1280x720 H.264/AAC MP4. Both recordings passed
ffprobe and Windows Media Foundation. Authenticated shutdown exited 0 with no
listener or partial files. Recursive CArchive/PYZ inspection confirmed all nine
`worldmedia_*` owners plus the current `index-Ce0fzRfT.js`, hls.js, frontend
index, and third-party notices are inside the executable; the build warning
report contains no missing selected World Media/WebView/CLR runtime module.

## 2026-07-14 - Archive startup, fixed-rendition IPTV, and recorded EQ

The reported zero-result Internet Archive startup was traced to a valid-shaped
but empty first browse page being committed as permanent exhaustion. Empty
first pages from the app's known nonempty curated collections now enter the
existing per-source retry/backoff path without advancing the cursor. A later
valid page clears the failure and browsing continues without an app restart.

The key IPTV evidence was that a stalled live player and a successful recorder
were consuming the same opaque relay but not the same rendition strategy.
FFmpeg selected one profile-appropriate rendition while hls.js remained free to
switch among a public master playlist's uneven variants. Live playback now
starts at the highest declared rendition at or below 720p, remains fixed there,
and steps strictly downward after a confirmed eight-second stall or bounded
network recovery. The independent audit removed an initial fallback ordering
that could eventually upshift after exhausting lower levels.

Recording now snapshots the effective current EQ at the moment the recording
starts. The frontend strips preset metadata and sends only preamp, ten numeric
bands, and bypass. The authenticated server and recorder independently require
the exact bounded shape, construct fixed FFmpeg filters without accepting any
filter syntax, apply the curve to MP3 and MP4 audio, and add a non-auto-level
limiter when processing is active. FFmpeg discovery now requires the five
filters used by that path. Changes made after recording begins apply to the
next recording; global/favorite automatic persistence remains unchanged.

Final evidence after the independent connection audit:

```text
JavaScript: 75/75 passed
Python: 93/93 passed including the final signal-level test
Focused final checks: 13/13 JavaScript; 43/43 Python
Real EQ filter encode: MP3 1.044898 s; MP4 1.000000 s H.264/AAC
Signal-level EQ integration: -12 dB preamp measured 10-14 dB below flat (passed)
Python syntax compilation: passed
Production frontend: 60 modules transformed
git diff --check: passed (line-ending notices only)
```

The rebuilt single-file artifact passed the isolated real executable smoke in
46.8 seconds. It verified direct/relayed HLS stream parity, downloaded the
known 9,436,391-byte MP3, recorded a 299,084-byte 14.928-second 160 kbps MP3,
recorded a 1,257,005-byte 10.413-second 1280x720 H.264/AAC MP4, opened both with
Windows media support, exited 0 through authenticated shutdown, and left no
listener or partial output.

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 11:00:43 -07:00
size: 18,872,153 bytes
SHA-256: EC69BD1274F2BD3CD491B4B984A2C060D8BE1FDD5E7FBA5EAC6F2DE0D4E5EB7D
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
```

## 2026-07-14 - Final browser acceptance and evidence audit

The remaining persistence evidence was strengthened rather than inferred. The
production EQ overlay harness now performs a real page reload between its write
and restore stages. Installed Edge, using an isolated profile, passed the exact
Global curve, two favorite scopes, two custom presets, 11 controls, 150 ms
autosave, `pagehide` flush, focus restoration, narrow scrolling, cache boundary,
and restored-control checks.

The production opaque-relay browser harness was also made unattended and gained
an explicit DASH pause/resume assertion. Its first real Edge run returned dash.js
initialization error 28. Direct request tracing showed 404 responses for both
initialization fragments. The defect was in the test fixture: FFmpeg placed six
DASH fragments in the repository working directory while the fixture server
published only its temporary DASH folder. The DASH encode now owns that temporary
folder as `cwd`; all seven manifest/fragment files are published and automatic
temporary-directory cleanup is restored. Production relay code did not change.

The repeated real Edge result was:

```text
audio/video/HLS/DASH signal: true / true / true / true
audio/video/HLS/DASH ended:  true / true / true / true
ordinary video pause/resume: true
DASH pause/resume:           true
Web Audio source nodes:      2
EQ frequency response:       +4.135, -2.987, -3.000 dB
```

JavaScript passed 75/75, Python passed 93/93, and Vite transformed 60 modules.
One intervening Python run saw a single Windows `WinError 10053` socket abort in
a control-API negative test. That exact test then passed three consecutive
repetitions and the full 93-test suite passed sequentially. Both harness ports,
isolated Edge processes, temporary profiles, and misplaced DASH fragments were
zero afterward.

Independent harness connection audit:

```text
EQ stage 1 -> normalized localStorage -> pagehide flush -> real location.reload
EQ stage 2 -> fresh module imports -> Global/favorite/custom data + UI restore

FFmpeg fixture -> temp DASH cwd -> MPD + init/media fragments -> fixture origin
fixture origin -> opaque DASH rewrite -> dash.js/MSE -> Web Audio signal
pause -> paused=true -> resume -> ended -> dash.js destroy
finally -> server + isolated Edge/profile + temporary fragments removed
```

No production defect was found in this follow-up. The exact final native-window
all-mode/EQ/public-DASH visual sweep remains open and is recorded without
qualification in `docs/FINAL_COMPLETION_AUDIT.md`.

## 2026-07-14 - Exact production-interface acceptance

A final test-only harness now wraps the generated `frontend/index.html` without
replacing its hashed production entrypoint. Installed Edge loaded
`/assets/index-B8bDhKXr.js` from a fresh isolated profile. Before the production
module ran, the harness seeded one loopback favorite and disabled all upstream
adapters; the favorite's media still passed through the real authenticated
opaque relay. This isolates interface connections from both the owner's saved
state and current internet availability.

The unattended result passed 12/12 groups: Library shell/sidebar/search/filters,
favorite search filtering, card/detail/player handoff, autoplay/pause/resume
state, favorite remove/add persistence, 11-control EQ integration, all five
modes, return-to-Library sidebar/detail restoration, Settings/runtime fields and
focus, stop cleanup, both Shutdown activation bindings, and zero unhandled
browser errors. The first two attempts exposed only harness assumptions (the
filter container selector and synthetic-click focus); both were corrected to
match production DOM and real pointer focus semantics before the passing run.

Post-harness independent connection audit:

```text
generated frontend/index.html -> exact hashed entry -> production boot
isolated favorite -> Library card -> detail -> player -> authenticated relay
player events -> Pause/Play affordance -> favorite LocalStorage persistence
mode teardown -> Tuner/Grid/Discovery/About -> Library shell/detail rebuild
Settings -> authenticated runtime status -> Escape -> prior focus
Shutdown init -> idempotent click + native pointerup bindings
```

The complete regression gate then passed again: JavaScript 75/75, Python 93/93,
Vite 60 modules, harness syntax compilation, and `git diff --check` (line-ending
notices only). No harness listener, isolated Edge process, or temporary profile
remained. The Windows Computer Use native pipe was unavailable on the final
retry, so the same acceptance sweep inside the native WebView window remains an
explicit observation gap rather than an inferred result.

## 2026-07-14 - Adaptive live HLS stability follow-up

The user confirmed recording quality and finalization were satisfactory but
reported that weaker IPTV channels could still stutter in the live player. This
follow-up was deliberately confined to hls.js playback. Recording registration,
FFmpeg selection/profiles, recording EQ, filename reservation, stop/finalize,
and the independent recording relay were not changed.

Live HLS now starts in automatic measured-bandwidth mode under a maximum 720p
ceiling. Low-latency mode is disabled, the live target is five fragments behind
the edge, maximum tolerated latency is twelve fragments, and forward/back
buffer ceilings were increased. Conservative bandwidth factors retain headroom
for irregular public sources and for the recorder's separate upstream request.
Three distinct short stalls without a genuine 30-second stable interval lower
the ceiling one rendition; the existing eight-second continuous-stall and
bounded fatal network/media recovery paths remain active.

The independent post-smoke audit found and repaired two gaps that green tests
alone had not revealed. First, a pending stable-reset timer survived the start
of a new buffering episode. It is now canceled immediately and has a dedicated
regression. Second, direct inspection of the vendored hls.js 1.5.13 setters
proved that `nextLevel` enables manual mode. Recovery now uses `nextAutoLevel`,
which applies to one fragment and resets, and only when the currently loaded
level is actually above the new ceiling. This prevents both permanent manual
quality and a one-fragment upshift when ABR already selected a lower rendition.

Final connection map:

```text
HLS manifest -> declared rendition indexes -> best <=720p ceiling
fragment delivery -> hls.js EWMA bandwidth/buffer estimate -> automatic level
waiting/stalled -> invalidate stable interval -> 3 short stalls OR 8s stall
recovery -> lower ceiling -> optional one-fragment nextAutoLevel -> automatic ABR
30s uninterrupted playing -> clear bounded recovery counters
Stop/item switch -> ownership invalidation -> recovery timers + HLS destroyed

record button -> separate opaque registration -> FFmpeg worker (unchanged)
record Stop -> recording job finalization only; live HLS ownership stays separate
```

Final evidence: focused HLS/player tests 7/7; full JavaScript 78/78; full Python
93/93; Vite 60 modules; real Edge relay audio/video/HLS/DASH signal and end
matrix passed; exact production bundle `/assets/index-hjMBDC5K.js` passed 13/13
groups including genuine HLS `currentTime` advancement and Stop cleanup;
`git diff --check` reported no whitespace errors.

The usual single-file artifact was then rebuilt and passed its isolated real
executable smoke in 40.4 seconds. Direct and relayed public HLS exposed the same
720/184/288/480/1080 video rendition set; the smoke downloaded a 9,436,391-byte
MP3, finalized a 299,084-byte 14.928-second MP3 and a 2,819,865-byte
16.466-second 1280x720 H.264/AAC MP4, opened both through Windows media support,
exited 0 through authenticated Shutdown, and left no partial output or listener.

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 12:50:50 -07:00
size: 18,873,436 bytes
SHA-256: F612A270536139149B0CA27A65D7DC976D1159F6943815341AADCDB5645ED195
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
```

## 2026-07-14 - Silent live-HLS freeze recovery

The user's weak favorite, `DanceTV Minimal Tech`, could begin playing and then
freeze without hls.js emitting a terminal error. Native request logging showed
normal master/media playlist and transport-segment traffic until it stopped
completely, while unrelated API polling continued. The current public master
manifest declares only 1920x1080 at 4,796,000 bps, 1280x720 at 2,266,000 bps,
and audio-only at 176,000 bps. The player was already using the smallest video
rendition, so a 480p/360p quality step was impossible.

Live playback now monitors genuine media-clock progress while playback is
active. If the clock has not advanced for eight seconds, the bounded HLS
recovery path lowers the video ceiling when a lower rendition exists; otherwise
it visibly reconnects the current 720p rendition. Recovery explicitly calls
`stopLoad()` before `startLoad(-1)` so a loader that hls.js still considers
active cannot make restart a no-op. Pause, End, Stop, item replacement, and
controller destruction cancel the heartbeat. A direct `currentTime` sample
prevents a delayed `timeupdate` event from causing a false reconnect, and fatal
events emitted during the same recovery episode are coalesced rather than
consuming another retry. Recording registration, FFmpeg capture, recording EQ,
and finalization were not changed.

Final connection map:

```text
playing -> 8s progress heartbeat -> sample currentTime
clock advanced -> accept progress -> rearm heartbeat
clock frozen -> bounded recovery -> lower ceiling if possible
no lower video -> stopLoad -> startLoad(-1) at 720p -> wait for progress
duplicate fatal/stall -> same recovery episode, no extra retry consumed
pause/end/stop/item switch -> cancel all recovery timers

record button -> separate opaque registration -> FFmpeg worker (unchanged)
```

The focused HLS/player suite passed 8/8, the complete JavaScript suite passed
79/79, and the complete Python suite passed 93/93. Vite transformed 60 modules
with final entry `/assets/index--sxmGMPY.js`; the exact production-interface
acceptance passed 13/13 groups, including genuine HLS time advancement and Stop
cleanup. `git diff --check` reported no whitespace errors. The usual EXE then
passed the real-artifact download, MP3 recording, 1280x720 H.264/AAC recording,
Windows media-open, authenticated Shutdown, listener cleanup, and partial-file
checks.

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 13:25:39 -07:00
size: 18,873,421 bytes
SHA-256: E4B514A84C73D656456842D9CEDFA967C6F8F2D6D6B2781F8302908518BAE068
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
```

## 2026-07-14 - Internet Archive dead-collection fallback

The owner's 13:55 launch showed Internet Archive indefinitely `retrying` with no
count. The native log also contained a burst of mixed proxy 200 and 502 results,
so transport instability was present, but it was not the reason the source could
never complete. The exact Archive query used in that ten-minute bucket selected
`tvnews` and repeatedly returned a valid HTTP 200 response with zero documents.
The same unrestricted playable-media filter currently returns zero for
`fedflix`. It returned nonzero inventories for the other curated collections:
`prelinger` 10,367; `feature_films` 28,392; `classic_tv` 11,553;
`classic_cartoons` 81; and `librivoxaudio` 21,635.

The prior empty-first-page repair correctly avoided false exhaustion, but its
retry preserved the same empty collection forever. Because automatic collection
selection changes every ten minutes, that created two deterministic dead slots
in every seven time buckets and explained the apparent time-of-day behavior.

The shared Internet Archive adapter now handles the two failure classes
separately:

```text
automatic first page -> scheduled/random curated collection
valid empty page -> rotate once through at most seven curated collections
first nonempty page -> return items + pin that collection in the page cursor
paged Library: all seven empty -> source-level retry without advancing a cursor

explicit collection -> remain exact; never substitute another collection
502/timeout -> two short transport retries -> source-level backoff on failure
```

The fallback is implemented for paged Library discovery, the adapter's generic
one-shot browse entry point, and random selection used by Discovery. Grid and
Tuner intentionally use Radio Browser/IPTV rather than Internet Archive. The
repair does not hide a genuine transport failure, does not loop without a bound,
and does not change an explicit collection request. A forced live `tvnews`
adapter call fell through to `librivoxaudio`, returned 30 real items, and
produced a page-two cursor pinned to that successful collection.

Independent post-smoke audit mapped `browse`, `browsePage`, and `random` through
the helper; verified exact-collection behavior, cursor ownership, all-empty
bounds, cancellation/transport propagation, and both first- and later-page
exhaustion. Final evidence:

```text
Focused Internet Archive/discovery tests: 11/11 passed
Complete JavaScript suite: 83/83 passed
Complete Python suite: 93/93 passed
Focused Windows socket-abort retest: 3/3 passed
Forced live tvnews fallback: 30 librivoxaudio items; page-two cursor pinned
Production frontend: 60 modules transformed
Real EXE smoke: download, MP3, MP4, media-open, Shutdown, cleanup passed
```

The exact current generated-browser sweep could not be rerun because the
isolated Browser runtime reported no available browser binding. The earlier
exact production bundle remains 13/13, and this hotfix changes only the Archive
adapter; no claim is made that the current hash received that browser sweep.

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 14:20:07 -07:00
size: 18,873,784 bytes
SHA-256: D4B6CEBFF75B918C2D3953E19076BFF722A83302DC9307A7DC1C0A0252780A02
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
frontend entry: /assets/index-Dc6s4H_-.js
```

## 2026-07-14 - Appearance themes and native title bar

Appearance is now a single validated setting shared by browser state, CSS, and
the native pywebview host. The Settings selector exposes System, Dark · Teal,
Light, Midnight · Blue, Forest · Green, Ember · Orange, and Amethyst · Violet.
Selections apply immediately, survive restart through the existing versioned
settings object, and invalid or legacy values migrate to System. System now
actually follows the complete Windows light/dark palette instead of changing
only the browser color-scheme hint.

The surface map was centralized around background, elevation, border, text,
accent, contrast, shadow, and chrome variables. Top bar, player bar, Library,
Tuner, Grid, Discovery, cards, filters, controls, and overlays all consume the
same palette without changing layout. Automated WCAG checks require normal
text, muted text, accent-button text, and caption text pairs to meet at least
4.5:1 contrast.

The native host exposes one allowlisted `set_theme` bridge method. On Windows
11, DWM caption, text, and border colors use the exact CSS chrome palette. On
Windows 10, where those explicit per-window color attributes are unavailable,
the host applies the matching supported dark/light caption style. Returning to
System clears custom Windows 11 colors and restores pywebview's OS-following
behavior. DWM failure remains cosmetic and cannot prevent startup.

Independent connection map:

```text
Settings select -> saveSettings -> normalizeTheme -> localStorage
                                      |
                                      +-> data-theme -> shared CSS variables
                                      |
                                      `-> pywebview set_theme -> strict allowlist
                                                               -> DWM caption

Windows scheme change + System -> CSS media query + native OS caption refresh
unknown persisted/native value -> System / rejected bridge call
```

Final evidence:

```text
Complete JavaScript suite: 87/87 passed
Complete Python suite: 98/98 passed
Theme catalog/palette/native parity audit: all connections passed
Contrast audit: every tested pair >= 4.5:1
Loaded WebView2/DWM smoke on Windows 10 build 19045: immersive dark = 1
Production frontend entry: /assets/index-XdvUhyMK.js
git diff --check: no whitespace errors
Real EXE smoke: download, MP3, MP4, media-open, Shutdown, cleanup passed
```

One repeated final-artifact run completed and validated its recording but the
external Windows Media Player opener returned exit code 12. An immediate rerun
of the same EXE hash passed media-open and every remaining gate; the artifact
was not changed between those two runs.

The isolated visual Browser runtime reported no available browser binding, so
the final subjective palette review remains explicitly unchecked in the release
checklist. No substitute browser controller was used to overstate that gate.

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 15:41:29 -07:00
size: 18,878,831 bytes
SHA-256: 572ED7DFD693515A70A2FB6085C164520009DC09A50FD8E2140E0EB36D3B515C
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
frontend entry: /assets/index-XdvUhyMK.js
frontend CSS: /assets/index-BoRFz97Z.css
embedded Python module: worldmedia_theme
```

## 2026-07-14 - Internet Archive 81-item completion correction

The Library was treating the end of one automatically selected Internet
Archive collection as the end of the complete provider. The visible count of
81 was the full filtered inventory of `classic_cartoons`, not the complete
Internet Archive inventory.

Automatic Archive browsing now owns one bounded cursor containing the seven
curated collections, an independent page number for each collection, and the
set of collections that still have pages. Each successful request rotates to
the next active collection. Finishing one collection removes only that
collection; the provider reports complete only when all seven have ended.
Explicit collection requests remain exact, valid known-empty buckets are
skipped, inconsistent short pages stay retryable, and every call is bounded to
one attempt per active collection.

Independent connection map:

```text
Library source progress
  -> Internet Archive automatic cursor
       -> collection A page N -> items -> A page N+1
       -> end of A            -> remove A -> continue with B
       -> transient bad page  -> throw -> preserve cursor/back off/retry
       `-> no collections left -> provider complete
```

Verification before packaging:

```text
Focused Internet Archive/discovery tests: 13/13 passed
Complete JavaScript suite: 89/89 passed
Complete Python suite: 98/98 passed
Production frontend: 61 modules transformed
Live Archive boundary: classic_cartoons page 3 returned its final 21 items
Live continuation: tvnews zero skipped, then 30 librivoxaudio items returned
git diff --check: no whitespace errors
Real EXE smoke: download, MP3, MP4, media-open, Shutdown, cleanup passed
```

```text
E:\WorldMediaWindows\dist\WorldMediaWindows.exe
timestamp: 2026-07-14 16:22:32 -07:00
size: 18,878,686 bytes
SHA-256: FCD3B826A12AFEFFFD65580ED9EB97B753293E991D3F8FF5F1CC3B59CF6EE9E1
Authenticode: NotSigned (expected for the local classic PyInstaller artifact)
embedded Archive bundle: frontend/assets/internet-archive-CrEW7usY.js
post-smoke WorldMediaWindows processes: 0
```
