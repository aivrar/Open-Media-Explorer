# Release Checklist

Record date, commit, operator, commands, result, artifact SHA-256, and any
expected upstream outage for every checked release.

## Clean build and automated gates

- [x] Verify Windows 10 22H2/11 x64, Edge WebView2, Python 3.13, Node 20+, and
  the exact versions in `requirements-build.txt`.
- [x] Run `npm ci`, `npm audit --audit-level=high`, both complete test suites,
  the reversed-order suites, and `npm run build`.
- [x] Confirm the eleven-source public source matrix and Phase 10 performance
  audit pass, or document a reproducible upstream-only failure.
- [x] Force automatic Internet Archive startup in the currently empty `tvnews`
  and `fedflix` buckets; verify bounded fallback in paged Library discovery,
  generic one-shot browse, and random Discovery, pin the successful collection
  cursor, keep explicit collection selection exact, and preserve the cursor
  after exhausted transport retries.
- [x] Run `python .\build_windows.py --skip-frontend` and
  `python .\build_single_exe.py --skip-frontend` from the clean bundle.
- [x] Record SHA-256 for both release artifacts, record the expected unsigned
  status of the classic EXE, verify the portable launcher Authenticode
  signature, and review generated assets and final diff.

## Packaged headless gates

- [x] Launch the final EXE with `WORLDMEDIA_NO_BROWSER=1` on a unique port.
- [x] Verify `/`, `/api/health`, `/api/v1/session`, authenticated runtime status,
  and `/THIRD_PARTY_NOTICES.txt`.
- [x] Submit authenticated shutdown and verify the process, listening port,
  FFmpeg/ffprobe children, staging archives, partials, and locks are gone.

## Writable portable functional matrix

- [x] Launch the final EXE from a new writable folder with no PATH FFmpeg and
  no managed `tools/` directory.
- [x] Confirm Library, Tuner, Grid, Discovery, About, settings, search/filter,
  detail restoration, playback controls, favorites, and shutdown.
- [x] Install the managed FFmpeg copy only after the disclosure/confirmation;
  verify provenance/license files and capability status.
- [x] Download one finite original, record live MP3 and live MP4, stop/finalize,
  open the outputs, and verify formats with ffprobe.
- [x] Apply Global EQ, two favorite curves, built-in/custom presets, restart,
  reselect, and confirm automatic persistence without a Save action.
- [x] Play a current non-DRM DASH channel and verify pause/resume/stop and a
  clear unsupported result for DRM content.
- [x] Run the production EQ overlay in installed Edge with an isolated profile;
  verify Global, two favorite scopes, two custom presets, focus/narrow layout,
  automatic persistence, and restored controls across a real page reload.
- [x] Run the opaque-relay browser matrix in installed Edge; verify real signal
  and completion for audio, video, HLS, and non-DRM DASH plus DASH pause/resume,
  bounded Web Audio source ownership, and backend DRM rejection coverage.
- [x] Run the exact production HLS path with automatic measured-bandwidth ABR,
  a 720p maximum ceiling, deeper live/buffer headroom, and repeated-short-stall
  fallback; verify real playback time advances and Stop cleans up.
- [x] Simulate a live HLS stream that silently stops advancing without emitting
  a stall/fatal event; verify the progress watchdog force-restarts the loader,
  coalesces duplicate recovery, avoids false reconnects when the media clock did
  advance, and remains disabled while paused.
- [x] Verify a master with no rendition below 720p reconnects at 720p instead of
  waiting for a nonexistent lower video level; recording remains independent.
- [x] Run the exact hashed production frontend in installed Edge with isolated
  state and loopback relayed media; verify all five modes, Library sidebar and
  detail restoration, search/filter, player state, favorite persistence, EQ,
  Settings/runtime fields, stop cleanup, and Shutdown click/pointer bindings.
- [x] Validate every appearance palette, normal-text/accent/title-bar contrast,
  theme migration, immediate persistence, bridge allowlist, and native Windows
  dark-caption DWM state with automated tests and a loaded WebView2 smoke.
- [x] Switch through System, Dark, Light, Midnight, Forest, Ember, and Amethyst
  in the exact production bundle; visually review the final layout and verify
  the native title-bar DWM bridge with the packaged WebView2 smoke.

The final production bundle passed its installed-Edge keyboard, focus, theme,
zoom, HLS, player, EQ, settings, and visual checks. Native launcher/theme and
shutdown ownership were independently exercised in the packaged smoke. See
`docs/FINAL_COMPLETION_AUDIT.md` for the exact evidence boundary.

## Alternate and failure matrix

- [x] Repeat tool discovery with a capable system PATH FFmpeg.
- [x] Test a read-only app folder: media download must be explicitly unavailable
  and the selected LocalAppData managed-tool destination must work.
- [x] Test no-network startup and recovery without resetting source cursors,
  favorites, settings, or EQ state.
- [x] Test a corrupted managed install: it must be rejected and Repair must
  stage, verify, and atomically replace it.
- [x] Start with existing 0.1.2 LocalStorage/WebView2 data and confirm migration
  preserves favorites, volume, source settings, and valid EQ state.
- [x] Test shutdown during install, download, recording, and finalization; a
  refused/incomplete shutdown must remain open with a retry action.

## Documentation and compliance

- [x] Confirm README, About, Settings help, build guide, file tree, changelog,
  privacy/runtime description, troubleshooting, and this checklist match the
  final controls and paths.
- [x] Confirm dash.js BSD-3-Clause, hls.js Apache-2.0, Python/runtime notices,
  embedded Python license, and optional FFmpeg provenance are available through
  the packaged `/THIRD_PARTY_NOTICES.txt`.
- [x] Confirm the release does not embed `downloads/`, `tools/`, user state,
  logs, test output, managed FFmpeg, or secrets.

## Final artifact record - 2026-08-01

- [x] Classic EXE: 18,919,875 bytes, SHA-256
  `6E99D9AD97D7058F1424D0D30FCFB201903FCDD662CA0A7492A0FD551D238458`,
  expected `NotSigned` status.
- [x] Portable ZIP: 14,624,027 bytes, SHA-256
  `420835939BBA3E38A0F29A943F5B0AFAEBBFE17EF7951ECCF450529FF0B2C295`.
- [x] Folder launcher: 104,160 bytes, SHA-256
  `95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`,
  valid Python Software Foundation Authenticode signature.
- [x] Current release gates: JavaScript 286/286, Python 148/148, npm audit
  with zero vulnerabilities, frontend production build, classic EXE build,
  portable ZIP build, packaged headless health/session/shutdown smoke, diff
  check, and a 443-entry ZIP audit with no user data or runtime output.
- [ ] Publish only after all gates have evidence; tag and upload only the
  reviewed `dist\WorldMediaWindows.exe` and
  `dist\WorldMediaWindows-0.1.2-portable.zip` whose hashes are recorded above.
