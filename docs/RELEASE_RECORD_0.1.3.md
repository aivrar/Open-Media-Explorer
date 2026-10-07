# v0.1.3 release verification - 2026-10-07

Release scope: local/online M3U playlists, direct links, Favorites filtering,
save-failure warnings, profile handoff, thumbnail queue recovery, shutdown,
and documentation. See [release notes](RELEASE_NOTES_0.1.3.md).

## Evidence

- `npm test`: 298 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 169 passing tests,
  including the existing real FFmpeg fixture integration tests.
- `npm audit --audit-level=high`: zero vulnerabilities after compatible updates
  to nanoid and source-map-js in the lockfile.
- `npm run build`: succeeds. Existing dash.js module-format/large-chunk warnings
  remain; they are not suppressed or presented as errors.
- Both release formats built in an isolated `dist/Release-v0.1.3` directory.
  Exact bundled frontend checked against `frontend/index.html`; the new native
  playlist module is present. ZIP integrity verified: 444 entries, no personal
  profiles, logs, downloads, tools, secrets, or repository metadata.
- Packaged EXE + installed Edge/Playwright: direct radio playback, online M3U
  import, file upload, HLS and non-DRM DASH playback advancing, Favorite media
  filters/search, all five modes, real storage-write failure warning/unchanged
  star, and Shutdown button/process exit. Favorites and playlists persisted
  through a native-process and fresh-browser restart.
- Screenshots reviewed at 1440x1000 and 960x800. Fixed column-wrap overflow;
  regression checks now require every Add link control to fit horizontally.
- Both EXE and ZIP launcher passed isolated headless launches, link/profile
  save/reload, restart, and prompt acknowledged shutdown with clean exit.
- Real WebView2 shell launched and loaded the packaged frontend. Native UI
  automation was unavailable (computer-use pipe missing; the launcher did not
  expose the requested CDP port), so interactive controls were checked in
  installed Edge against the packaged backend instead. Native shutdown was
  confirmed through the authenticated control API.
- The existing portable installation was backed up and all copied profile
  files hash-verified before replacing the executable. Personal data is not
  part of this commit or any release asset.

Browser acceptance can be rerun with the optional installed `playwright` Python
package and Microsoft Edge: `python tests_python/playlist_release_browser_smoke.py`.
It uses disposable state under `build/`, never the personal test profile. Live
test providers can fail transiently: one HLS rerun timed out; complete runs
before and after passed. This is not a guarantee of upstream availability.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,934,898 | `AE08BB1138CA031C9E9C53B3F9C066C41087C15FFEBE05184418C807D0D4A22B` |
| `WorldMediaWindows-0.1.3-portable.zip` | 14,633,595 | `497FB303E7D27CD1C2CDB72FE02F9A59CF9950724215F270593E3163A1156ECD` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

The historical v0.1.2 exhaustive appearance/recording/provider matrix was not
fully repeated; this release has the focused evidence above. Favorites remain
in WebView2 storage; the native cross-port backup is bounded to 2 MiB of raw
values and now warns on failure. Playlist imports are snapshots, not subscriptions,
and are available in Library/Favorites rather than Grid/Tuner/Discovery.
EQ/volume/job-history persistence is not migrated to a native database.

Publish a new v0.1.3 tag/release, keep v0.1.2 for rollback, verify downloaded
asset hashes, and update the wiki and issue #1 only with the published links.
