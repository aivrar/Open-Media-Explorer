# Player Capture and Equalizer Execution Plan

Status: ready for phased execution
Created: 2026-07-10
Research basis: [PLAYER_CAPTURE_EQ_RESEARCH.md](PLAYER_CAPTURE_EQ_RESEARCH.md)

## Execution contract

This plan is intentionally gated. A phase is not complete because its code was
written; it is complete only when every task and exit gate for that phase passes.

Rules for execution:

1. Work on one phase at a time in the listed order.
2. Re-read the research sections referenced by that phase before editing.
3. Preserve unrelated existing worktree changes.
4. Add or update tests in the same phase as behavior.
5. Run the phase's focused tests first, then the complete regression suite.
6. Do not weaken security, error handling, or tests to make a gate pass.
7. Record any architecture change in the research dossier before continuing.
8. Keep FFmpeg command construction pure/testable; subprocess execution is a
   separate boundary.
9. Never use live third-party services as the only automated test oracle.
10. At the end of every phase, run `git diff --check` and review the phase diff.

Standard regression commands once the Python test harness exists:

```powershell
npm test
python -m unittest discover -s tests_python -p "test_*.py"
npm run build
git diff --check
```

## Phase 0 — Freeze contracts and establish test infrastructure

Goal: make all later work measurable without changing production behavior.

### Tasks

- [x] Capture the current player bar DOM, responsive layouts, settings modal,
  item model, adapter outputs, API routes, and runtime paths in test fixtures.
- [x] Add `tests_python/` using the standard-library `unittest` runner.
- [x] Add reusable local fixture servers for:
  - finite audio and video files;
  - HTTP Range requests;
  - endless audio bytes;
  - HLS VOD and HLS live manifests/segments;
  - redirects to public and rejected private targets;
  - required Referer/User-Agent behavior;
  - slow, interrupted, and malformed responses.
- [x] Add fake-process and fake-clock seams for job/FFmpeg tests.
- [x] Add frontend DOM/media fakes sufficient to test player state without a
  real network.
- [x] Update CI to run JavaScript tests, Python tests, frontend build, and Python
  syntax parsing.
- [x] Define JSON schema fixtures for session, runtime, tool status, media
  registration, and jobs. These are frozen before server implementation.
- [x] Record baseline startup/build/package smoke results.

### Exit gate

- [x] Existing tests remain green.
- [x] New harness tests prove fixtures can simulate finite/live media, Range,
  redirects, cancellation, and process progress deterministically.
- [x] CI invokes both language test suites.
- [x] No production behavior changes appear in the phase diff.

## Phase 1 — Correct player state ownership and play/pause UI

Goal: fix the reported icon defect and create stable seams for later actions.

Research references: Playback events; Current player audit.

### Tasks

- [x] Introduce `player-state.js` with an explicit active media element and
  monotonic playback generation.
- [x] Add one `syncPlaybackUi(reason)` function as the only writer of:
  - `state.isPlaying`;
  - play/pause SVG visibility;
  - play button label, title, and `aria-pressed` if used;
  - seek enabled/duration/time state.
- [x] Ignore lifecycle events from the inactive element or a stale generation.
- [x] Handle `play`, `playing`, `pause`, `ended`, `emptied`, `error`, and source
  switches consistently.
- [x] Ensure rejected `play()` promises restore a playable/error UI rather than
  leaving a pause icon.
- [x] Ensure stop and broken-stream states cannot be overwritten by late events.
- [x] Preserve current public player exports so modes do not require a broad
  rewrite.
- [x] Add Media Session play/pause handlers only if supported; they must call the
  same player methods rather than write state independently.

### Tests

- [x] Audio playing plus late video pause keeps the pause icon.
- [x] Video playing plus late audio emptied/error keeps the pause icon.
- [x] Pause, resume, ended, stop, rapid source switching, and rejected play each
  produce the correct icon and state.
- [x] Accessible labels match the action (`Play` versus `Pause`).

### Exit gate

- [x] Focused player tests and full regressions pass.
- [x] Manual packaged playback confirms correct icons for one audio file, radio,
  direct video, and HLS video.
- [x] No inactive media event can mutate the visible player state.

## Phase 2 — Add media capability and EQ persistence contracts

Goal: make behavior data-driven and migration-safe before adding buttons.

Research references: Item model; Source mapping; State and persistence.

### Tasks

- [x] Extend the normalized item model with `delivery`, `download_url`, optional
  `download_name`, and sanitized capture header metadata.
- [x] Add pure capability resolution returning one of:
  `download`, `record-audio`, `record-video`, `checking`, or `unavailable`.
- [x] Update every adapter according to the approved source matrix.
- [x] Update lazy resolvers to populate playback and download URLs together.
- [x] Preserve IPTV referrer/user-agent metadata in the public sanitized shape.
- [x] Add manifest inspection fallback for unknown HLS VOD/live and static/dynamic
  DASH without overriding adapter-declared delivery.
- [x] Define versioned defaults and validators for recording quality and EQ data.
- [x] Implement localStorage migration that tolerates missing, corrupt, partial,
  or future-version data without losing favorites/settings.
- [x] Define favorite transition helpers:
  - favorite current item: clone current effective curve;
  - unfavorite: delete item curve and restore global if current.
- [x] Update cache-clearing semantics and confirmation text.

### Tests

- [x] Every adapter returns valid capability fields before/after lazy resolution.
- [x] HLS ENDLIST/VOD and live fixture classification is correct.
- [x] Corrupt and legacy storage migrates to validated defaults.
- [x] Favorite/unfavorite transitions produce the specified effective EQ.
- [x] IPTV headers are preserved but CR/LF and non-allowlisted headers are not.

### Exit gate

- [x] Capability decisions contain no scattered source-ID checks in player UI.
- [x] Existing saved favorites/settings load without manual reset.
- [x] Full adapter regression suite passes.

## Phase 3 — Build the secure localhost control foundation

Goal: add backend authority without exposing file/process operations to arbitrary
web pages or arbitrary parameters.

Research references: Localhost API and SSRF security; Backend control API.

### Tasks

- [x] Split security/runtime/job service modules from the HTTP handler.
- [x] Add a per-launch cryptographic anti-CSRF token and `/api/v1/session`.
- [x] Require exact Host, exact Origin, JSON content type, bounded body, and
  `X-WorldMedia-Token` on every mutation.
- [x] Keep control responses same-origin only; do not add wildcard CORS.
- [x] Return structured versioned errors with stable codes and safe messages.
- [x] Add portable-root, state-root, downloads-root, tools-root, and writable
  probe helpers. Never confuse `_MEIPASS` with the portable root.
- [x] Add Windows filename/path sanitizer and atomic target reservation.
- [x] Create thread-safe in-memory job registry with allowed state transitions,
  idempotency checks, concurrency limits, bounded history, and redacted errors.
- [x] Add shutdown hooks that query/stop active jobs before process exit.
- [x] Add request IDs and bounded/redacted logging.

### Security tests

- [x] Wrong/missing Origin, Host, token, content type, or method is rejected.
- [x] Cross-origin preflight is not authorized.
- [x] Oversized/malformed JSON is rejected before work starts.
- [x] Titles containing quotes, metacharacters, traversal, reserved names, Unicode,
  and very long text cannot escape the output directory.
- [x] Job state transitions reject races and illegal duplicates.

### Exit gate

- [x] Security tests pass on Windows CI.
- [x] No API accepts an FFmpeg argument list, shell command, or output path from
  the frontend.
- [x] Existing health/proxy/shutdown smoke tests remain green.

## Phase 4 — Implement the safe same-origin media relay

Goal: support Web Audio and backend capture while preserving upstream headers
and preventing SSRF/DNS-rebinding/redirect bypass.

Research references: Web Audio CORS; Playback routing; Security invariants.

### Tasks

- [x] Implement media registration from validated item capabilities.
- [x] Issue random, scoped, expiring relay tokens; never put the upstream URL in
  a public GET query.
- [x] Implement a safe HTTP/HTTPS connector that:
  - rejects credentials and non-HTTP schemes;
  - resolves and connects to a selected globally routable IP;
  - preserves TLS hostname verification/SNI;
  - repeats validation on every redirect;
  - applies only sanitized Referer/User-Agent headers;
  - enforces connect/header/idle timeouts and cancellation.
- [x] Support GET, HEAD, Range, Content-Range, content type/length, and continuous
  backpressure-aware streaming.
- [x] Keep relay limits independent from metadata proxy limits/rate counting.
- [x] Implement HLS manifest rewriting for URI lines and URI attributes covering
  variants, media, maps, keys, and segments with scoped child tokens.
- [x] Ensure HLS relative URLs resolve against the original manifest, not
  localhost.
- [x] Feed direct media and HLS through local URLs where EQ/CORS requires it.
- [x] Expire registrations on stop, item switch after grace, or shutdown.

### Tests

- [x] Finite, Range, seek, endless stream, redirect, header, and cancellation
  fixtures pass.
- [x] Private IPv4/IPv6, localhost, link-local, metadata, encoded hosts, redirect
  pivots, and DNS change attempts are rejected.
- [x] Rewritten HLS master/media/key/segment URLs remain functional and opaque.
- [x] Slow consumers apply backpressure without unbounded memory growth.
- [x] Relay disconnects do not generate traceback floods.

### Exit gate

- [x] Existing playable direct audio/video/HLS fixture media still plays.
- [x] Analyser smoke test proves nonzero Web Audio samples for relayed
  cross-origin-style fixtures.
- [x] No relay request can reach a non-global target.

## Phase 5 — Implement verified FFmpeg discovery and installation

Goal: provide a portable, replaceable, integrity-checked toolchain with explicit
licensing and no administrator requirement.

Research references: FFmpeg acquisition/licensing; Safe process/archive handling.

### Tasks

- [x] Implement discovery order and capability probes for ffmpeg and ffprobe.
- [x] Require the actual encoders, protocols, demuxers, and muxers used by the
  approved command profiles.
- [x] Add status API with source (`override`, `portable`, `PATH`, `LocalAppData`),
  version, capabilities, managed/unmanaged flag, and actionable reason.
- [x] Implement the BtbN/GitHub release query with exact repository/asset checks.
- [x] Stream download with progress, cancellation, timeout, retry, and size cap.
- [x] Verify GitHub asset SHA-256 before extraction.
- [x] Inspect CRC, member paths, symlinks, file count, and expanded size.
- [x] Stage, probe, atomically install, and retain license/readme/source links.
- [x] Never replace a working install until the new staging probe succeeds.
- [x] Add Repair and Remove Managed Copy; never remove a system PATH install.
- [x] Add install confirmation/status UI and automatically resume the initiating
  recording after successful consent/install.
- [x] Add FFmpeg attribution and third-party license links to About and docs.

### Tests

- [x] Valid install, cancellation, HTTP failure, bad digest, truncated ZIP, CRC
  failure, traversal, zip bomb, missing exe, missing capability, and atomic
  rollback all pass with fixtures/mocks.
- [x] A real opt-in integration test probes the current approved asset in CI or a
  scheduled workflow without making normal unit tests download 160+ MiB.
- [x] System FFmpeg with missing capabilities correctly falls through to managed
  install rather than failing later during capture.

### Exit gate

- [x] A clean Windows machine can install without admin rights and reports a
  verified version/capability set.
- [x] Installed license files and manifest are present.
- [x] Corruption cannot result in execution.
- [x] License/compliance review is signed off before release packaging proceeds.

## Phase 6 — Implement finite downloads

Goal: download original finite media reliably into the portable downloads
directory without requiring FFmpeg when no conversion is needed.

Research references: Download classification; Filesystem; Job model.

### Tasks

- [x] Add download start/cancel/status API using only a media registration ID.
- [x] Stream through the safe connector to a reserved `.part` path.
- [x] Report bytes and percentage when Content-Length is trustworthy; show bytes
  and elapsed time otherwise.
- [x] Support cancellation, timeout/retry policy, redirects, Range resume only
  when validator/length semantics make it safe, and atomic completion.
- [x] Validate expected content type and reject HTML/error pages masquerading as
  media when possible.
- [x] Preserve source extension from trusted metadata/content type, not raw title.
- [x] Handle LibriVox full-audiobook ZIP explicitly and label it accurately.
- [x] Prevent duplicate active downloads and final-name collisions.
- [x] Add open-downloads-folder API fixed to the validated downloads root.
- [x] Keep completed output when cache/settings are cleared.

### Tests

- [x] Known/unknown length, Range resume, changed ETag, redirects, cancellation,
  disk/write failure, collision, malformed content, and duplicate job pass.
- [x] Every on-demand adapter downloads the expected fixture artifact.
- [x] Cancelled/failed downloads never appear under a final filename.

### Exit gate

- [x] Internet Archive, NASA, Wikimedia, and LibriVox manual sample downloads open
  successfully and match expected size/hash where available.
- [x] No FFmpeg installation is triggered for an original finite download.

## Phase 7 — Implement live recording and finalization

Goal: create reliable MP3 audio and MP4 video recordings with graceful stop,
progress, reconnect behavior, and validation.

Research references: FFmpeg capture/output; Recording profiles; Job model.

### Tasks

- [x] Implement pure FFmpeg/ffprobe argument builders with fixed allowlisted
  options and local relay input only.
- [x] Probe input streams with strict timeout and choose audio/video profile.
- [x] Implement Compact, Balanced, and High profiles exactly as documented.
- [x] Video writes interruption-resilient fragmented working MP4, then remuxes
  and validates a normal fast-start MP4 on stop.
- [x] Audio writes a temporary MP3 and validates before atomic publication.
- [x] Apply bounded network reconnect settings suitable for continuous streams.
- [x] Parse `-progress pipe:1`; concurrently drain bounded/redacted stderr.
- [x] Start FFmpeg hidden with `shell=False` and no command window.
- [x] Stop by writing `q`, waiting, then terminate/kill only on timeout.
- [x] Preserve a recoverable working file and clear status if finalization fails.
- [x] Enforce one active recording and idempotent Stop Recording.
- [x] Keep recording independent from playback pause; expose global active job
  when another item is selected.
- [x] Integrate graceful application shutdown/finalization.

### Tests

- [x] Exact argument vectors reject injection strings and never contain remote
  URLs or browser-supplied output paths.
- [x] Fake FFmpeg progress, errors, hangs, early exits, stop races, and stderr
  floods are handled without deadlock.
- [x] Local audio fixture produces valid MP3 at each bitrate tolerance.
- [x] Local HLS/video fixture produces valid H.264/AAC MP4 at each resolution
  ceiling and approximately expected quality.
- [x] ffprobe verifies codec, container, duration, and stream presence.
- [x] Interrupted working MP4 is recoverable; normal stop publishes only the
  finalized file.

### Exit gate

- [x] Manual Radio Browser audio and iptv-org HLS video recordings stop cleanly
  and open in Windows media players.
- [x] A failed recorder cannot leave the UI claiming it is recording.
- [x] No orphan FFmpeg process remains after stop, failure, or app shutdown.

## Phase 8 — Add player action UI and recording settings

Goal: expose download/record workflows clearly without damaging the compact
player bar or accessibility.

Research references: Player bar behavior; Backend API.

### Tasks

- [x] Add one context action component with Download, Record, Stop Recording,
  checking, installing, downloading, finalizing, completed, and failed states.
- [x] Add an adjacent EQ button with active/bypassed indication.
- [x] Add a dedicated status/elapsed/progress region rather than overwriting
  item title/source.
- [x] Keep control state synchronized from backend job state after mode/item
  changes and app focus changes.
- [x] Add cancel/retry/open-folder affordances where safe.
- [x] Add Settings section for recording quality, downloads/tools paths,
  FFmpeg status/install/repair/remove, and license links.
- [x] Show the actual output directory and portable-root writability.
- [x] Preserve desktop and narrow responsive layouts; icons gain labels/tooltips
  when text collapses.
- [x] Implement keyboard navigation, focus visibility, ARIA labels/live updates,
  disabled reasons, and reduced-motion behavior.

### Tests

- [x] Capability-to-label/state mapping covers every job state.
- [x] Switching items during jobs and restoring a mode keeps correct status.
- [x] Keyboard, focus, labels, live messages, and narrow layout snapshots pass.
- [x] Settings persist immediately and invalid stored values normalize.

### Exit gate

- [x] Every action has an unmistakable state and recovery path.
- [x] No player control is clipped at supported minimum window size.
- [x] Manual screen-reader/keyboard pass is recorded.

## Phase 9 — Build the Web Audio equalizer engine

Goal: provide deterministic, click-free real-time EQ across supported playback
paths before building the full overlay.

Research references: Web Audio; Approved EQ graph; Playback routing.

### Tasks

- [x] Implement one lazily created AudioContext and exactly one source node per
  media element.
- [x] Build preamp, ten bands, safety compressor, analyser/response support, and
  destination connections.
- [x] Use approved frequencies/types/ranges and smoothed parameter updates.
- [x] Implement bypass without destroying the stored curve or duplicating paths.
- [x] Resume context from play/EQ user gestures and expose unavailable/error state.
- [x] Apply effective EQ before/while a newly selected item begins playback.
- [x] Prevent inactive elements, source switches, and HLS reattachment from
  duplicating graph connections.
- [x] Detect silence/relay failures sufficiently to avoid a falsely active EQ;
  fall back visibly rather than silently muting playback.

### Tests

- [x] Fake AudioContext verifies exact graph topology, single source creation,
  band parameters, smoothing, bypass, and item switching.
- [x] Offline/local audio measurements verify flat response tolerance and that
  representative boost/cut curves affect expected frequencies.
- [x] Relayed direct audio, relayed direct video, HLS/MSE, and radio fixtures all
  produce audible output with EQ active.
- [x] Volume/mute/seek/play/pause continue to work through the graph.

### Exit gate

- [x] EQ produces no silence regression on the source fixture matrix.
- [x] Rapid slider movement and source switching do not produce exceptions,
  clipping, duplicate audio, or unacceptable crackle.
- [x] CPU impact is measured and acceptable at idle/active states.

## Phase 10 — Add EQ overlay, presets, and automatic scope persistence

Goal: deliver the complete interaction model requested by the user.

Research references: Equalizer UI and behavior; EQ persistence.

### Tasks

- [x] Build an accessible overlay with ten bands, preamp, bypass, reset, built-in
  preset selection, custom preset management, and response curve.
- [x] Display current scope (`Global` or favorite title) prominently.
- [x] Apply slider/preset changes immediately.
- [x] Debounce persistence without an Apply/Save button for active EQ state.
- [x] Implement built-in curves with headroom-safe preamp values.
- [x] Implement custom preset create/rename/delete; edits to a selected custom
  preset auto-update it.
- [x] Snapshot preset curves into global/favorite scopes as specified.
- [x] Handle favorite/unfavorite events while overlay is open or closed.
- [x] Preserve focus, Escape close, backdrop behavior, keyboard slider increments,
  and responsive horizontal scrolling/compact modes.
- [x] Ensure malformed/extreme persisted values are clamped before touching
  AudioParams.

### Tests

- [x] Global changes persist and apply to multiple non-favorites.
- [x] Each favorite restores its own curve across restart.
- [x] Favoriting clones current sound; unfavoriting restores global and removes
  the favorite curve.
- [x] Built-ins remain immutable; custom preset lifecycle behaves as specified.
- [x] No close/apply/save action is required for current EQ persistence.
- [x] Accessibility and narrow-layout interaction tests pass.

### Exit gate

- [x] Manual A/B listening confirms immediate and correctly scoped changes.
- [x] Restart/reselection persistence matrix passes for global, two favorites,
  built-ins, and two custom presets.
- [x] Clear-cache behavior matches its warning and does not delete media/tools.

## Phase 11 — Cross-source integration, resilience, and performance audit

Goal: test the whole feature under realistic source diversity and failure rather
than judging it from isolated unit tests.

### Source matrix

- [x] Radio Browser: HTTP MP3, HTTPS AAC/AAC+, and HLS radio.
- [x] iptv-org: ordinary HLS, required Referer, required User-Agent, HTTP HLS,
  DASH where non-DRM, and a broken channel.
- [x] Internet Archive: audio and video derivative.
- [x] NASA: audio and video manifest resolution.
- [x] Wikimedia: MP3/OGG and MP4/WebM.
- [x] LibriVox: playback chapter and full-audiobook ZIP download.

### Resilience tasks

- [x] Test network loss/recovery during download, recording, relay playback, and
  FFmpeg install.
- [x] Test disk-full/write-denied/read-only portable root and explicit fallback.
- [x] Test sleep/wake, app focus loss, mode changes, rapid item changes, and long
  recordings.
- [x] Test shutdown during install/download/record/finalize.
- [x] Confirm no unbounded job/log/token/relay/thread/process growth.
- [x] Benchmark relay memory, recording CPU, EQ CPU, and UI responsiveness.
- [x] Confirm playback and capture headers work without leaking secrets to logs.
- [x] Verify DRM/encrypted/unsupported media produces a clear unsupported state.
- [x] Review all new endpoints for CSRF, SSRF, traversal, injection, race, and
  denial-of-service issues.

### Exit gate

- [x] Automated full suite passes repeatedly without order dependence.
- [x] Source matrix results and expected upstream failures are documented.
- [x] No high/critical security finding or orphan process/file defect remains.
- [x] Performance stays within agreed limits and the player remains responsive.

## Phase 12 — Packaging, compliance, documentation, and release audit

Goal: prove the portable release—not only the source tree—is complete.

### Tasks

- [x] Update README, About, settings help, build docs, file tree, changelog,
  release checklist, privacy/runtime description, and troubleshooting.
- [x] Document downloads/tools locations, read-only behavior, quality profiles,
  recording independence from pause, output finalization, and content rights.
- [x] Include FFmpeg provider/version/license/source/build links and managed-tool
  replacement/removal instructions.
- [x] Update Windows requirements if FFmpeg build compatibility requires 10 22H2+.
- [x] Update build/package data and ignore rules for planning/runtime artifacts
  without embedding downloaded tools unintentionally.
- [x] Run clean dependency install, all tests, frontend build, portable build,
  and headless packaged smoke.
- [ ] Launch the final EXE from a writable portable folder with no system FFmpeg;
  install, download, record audio/video, apply/persist EQ, restart, and retest.
- [x] Repeat with system FFmpeg, read-only app folder, no network, corrupted
  managed install, and existing user storage from 0.1.2.
- [x] Confirm shutdown leaves no listener, process, staging archive, partial final
  filename, or locked executable.
- [x] Review final diff and generated bundles; confirm only intended files changed.
- [x] Complete license/compliance review before publishing any release asset.

### Exit gate

- [ ] Final EXE passes the complete functional/security/source matrix.
- [x] All output files open and ffprobe verifies required formats.
- [x] Fresh and upgrade paths both pass.
- [x] Documentation matches actual paths, controls, and failure behavior.
- [ ] Release checklist contains evidence for every final rubric category.

## Definition of 10/10 complete

The feature receives one point in each category only when its evidence exists.
All ten are required; a partial score is not release-complete.

1. **Playback correctness** — active-element state is authoritative; icons,
   labels, progress, stop, and failures are correct under races.
2. **Download correctness** — every finite source has an accurate, cancellable,
   atomic original download path with safe filenames.
3. **Recording correctness** — live audio produces validated MP3 and live video
   validated MP4 at all profiles, with graceful stop/recovery.
4. **EQ correctness** — audible ten-band/preamp/bypass processing works without
   CORS silence, duplicates, clipping regressions, or broken base controls.
5. **Persistence correctness** — global/favorite/custom state applies and
   auto-persists exactly as specified across favorite changes and restart.
6. **Portability** — clean Windows deployment can verify/install/replace FFmpeg,
   use app-adjacent downloads, and handle read-only locations explicitly.
7. **Security** — CSRF, SSRF/DNS rebinding, redirect pivot, traversal, command
   injection, unsafe ZIP, token leakage, and job races have passing negative tests.
8. **Reliability/performance** — loss, cancellation, shutdown, long streams,
   resource bounds, and orphan cleanup pass without freezing the UI.
9. **UX/accessibility** — responsive player/overlay, keyboard/focus/labels/live
   status, visible progress/errors, and no hidden save requirement pass review.
10. **Compliance/release quality** — licensing/content-rights notices, source
    links, docs, CI, full tests, production build, packaged smoke, and upgrade
    verification are complete.

## Required final evidence bundle

Before marking the task complete, attach or record:

- full JavaScript and Python test output;
- frontend and portable build output;
- packaged health/startup/shutdown smoke output;
- ffprobe JSON for one audio and one video result per quality profile;
- source matrix checklist;
- security negative-test summary;
- performance/resource measurements;
- screenshots of desktop/narrow player, recording states, settings, and EQ;
- persisted-state restart matrix;
- FFmpeg manifest/digest/license verification;
- final `git diff --check`, status, EXE timestamp/size, and no-process/no-port audit.
