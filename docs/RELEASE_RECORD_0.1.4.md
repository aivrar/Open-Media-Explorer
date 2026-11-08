# v0.1.4 release verification - 2026-11-08

Release scope: favorites-first Library, Tuner "My favorites" source, compact
saved-item cards, progressive Tuner/Grid loading with per-source time limits,
artwork repair (.ico conversion, generic-type and trailing-byte fixes), initials
placeholders, simplified source labels with a technical-details setting, title
bar theming on Windows 10, short-HLS startup, and repository cleanup. See
[release notes](RELEASE_NOTES_0.1.4.md).

## Evidence

- `npm test`: 313 passing JavaScript tests.
- `python -m unittest discover -s tests_python -p 'test_*.py'`: 184 passing tests.
- `npm audit`: zero vulnerabilities after updating Vite to 8.3.6.
- `python -m ruff check --select F,E9`: clean.
- `npm run build`: succeeds. Existing dash.js module-format/large-chunk warnings
  remain; they are not suppressed or presented as errors.
- `tests_python/production_ui_harness.py` in installed Edge (autoplay allowed):
  passed every check, including all modes, all themes, Settings, EQ, 200% zoom,
  favorite persistence, and production HLS start/stop.
- `tests_python/playlist_release_browser_smoke.py` against the packaged EXE with
  disposable state: direct radio playback, online M3U and local file import, real
  HLS and DASH playback advancing, Favorites filter/search, all modes, layout
  screenshots, save-failure warning, Shutdown exit, and restart persistence.
- ZIP integrity verified: 444 entries; bundled frontend byte-identical to
  `frontend/`; no profiles, logs, downloads, tools, or repository metadata.
- Artwork repair checked against the 300 most-clicked Radio Browser stations:
  20 logos recovered; only HTML/text responses and SVG logos remain refused.
- Packaged EXE used on the maintainer's portable profile (backup kept) for
  Favorites, Tuner, Grid, and title-bar behaviour.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 18,943,445 | `A3287D652F8C1D5B5674E113E9B10955E552D21EE37F8D710B1D69C15255E0B9` |
| `WorldMediaWindows-0.1.4-portable.zip` | 14,638,591 | `36592803B302180C421BE5B6D4E64D0F8D71E98449A62A650051873EB47411B3` |

The classic one-file EXE is unsigned. The ZIP's unmodified Python launcher has
a valid Python Software Foundation Authenticode signature (launcher SHA-256
`95225ED035643523E8C586C11981E276541DCE4949EB35CF8CF5741C824249D4`).

## Boundaries

The historical v0.1.2 exhaustive appearance/recording/provider matrix was not
fully repeated; this release has the focused evidence above. The vendored
hls.js remains 1.5.13. SVG station logos stay blocked because the artwork relay
serves at the app origin. The Windows 10 title bar follows dark/light mode only;
exact palette colours need Windows 11.
