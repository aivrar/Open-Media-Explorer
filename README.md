# Open Media Explorer

![Latest release](https://img.shields.io/github/v/release/aivrar/Open-Media-Explorer?display_name=tag&sort=semver)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2022H2%2F11-0078D4)
![Portable](https://img.shields.io/badge/portable-single%20EXE-2ea44f)
![Sources](https://img.shields.io/badge/public%20sources-11-F28C52)
![Privacy](https://img.shields.io/badge/accounts%20%7C%20telemetry-none-success)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)

**Explore the world's open media from one portable Windows app.** World Media
brings together internet radio, live television, podcasts, public-domain films,
space media, cultural archives, audiobooks, conference recordings, PeerTube,
and independent Owncast streams from eleven public sources.

Search everything, save favorites, browse a live-channel Grid, spin the Tuner,
discover something unexpected, shape playback with a ten-band EQ, download
finite media, and optionally record live streams. No account, subscription,
API key, or telemetry.

[**Download the latest EXE**](https://github.com/aivrar/Open-Media-Explorer/releases/latest/download/WorldMediaWindows.exe)
· [Full documentation](docs/wiki/README.md)
· [Release history](https://github.com/aivrar/Open-Media-Explorer/releases)

![Open Media Explorer - Library view](screenshots/updated%20screenshots/all_sources.PNG)

| Tune live radio and TV | Discover something unexpected |
|---|---|
| ![World Media Tuner](screenshots/updated%20screenshots/tuner.PNG) | ![World Media Discovery](screenshots/updated%20screenshots/discovery.PNG) |

![Ten-band equalizer with automatic presets](screenshots/updated%20screenshots/eq.PNG)

## Install

For the classic one-file Windows app, download and run:

```text
WorldMediaWindows.exe
```

The executable is unsigned and some heuristic antivirus products may require
the file or its containing folder to be explicitly allowed. The alternative
signed-runtime portable package is:

```text
WorldMediaWindows-0.1.2-portable.zip
```

For that package, extract the entire archive, keep its files together, and run
`WorldMediaWindows.exe` inside the `WorldMediaWindows` folder. Either form starts
a local server on `127.0.0.1`, opens a native WebView2
window, and stores its cache, favorites profile, settings, and logs beside the
launcher under:

```text
WorldMediaWindows-data\
```

An existing `%LOCALAPPDATA%\WorldMediaWindows\webview2_data` profile is copied
there once to preserve favorites; the legacy source is not deleted automatically.
The classic single EXE uses the Windows temporary directory only for its
transient startup extraction and cleans its `_MEI...` directory on normal
shutdown. Persistent app data always remains beside the EXE.

Users do not need Python, Node, Rust, Git, Docker, or WSL.

## Documentation

The full end-to-end user and developer wiki is in
[docs/wiki/README.md](docs/wiki/README.md), with a short index at
[docs/WIKI.md](docs/WIKI.md).

## What You Get

Five tabs across the top: **Library**, **Tuner**, **Grid**, **Discovery**, and
**About**.

**Library** - search and browse everything. Left sidebar groups results by type
and source: Radio Browser, iptv-org, Internet Archive, NASA, Wikimedia Commons,
LibriVox, media.ccc.de/C3VOC, Library of Congress, gPodder Podcasts, PeerTube,
and Owncast.

![Library - TV channels with sidebar counts](screenshots/1.PNG)

**Tuner** - a radio-style dial for live radio and live TV. Drag the dial or use
arrow keys; each station gets a cosmetic frequency.

![Tuner - analog dial](screenshots/2.PNG)

**Library detail panel** - click any item to see metadata, license, source, and
play it.

![Library - detail panel with Wikimedia Commons video](screenshots/3.PNG)

**Grid** - TV-guide-style tiles for live radio and live TV.

**Discovery** - random open media from the enabled sources.

Library discovery is intentionally bounded. It fetches fairly from every
enabled source, pauses when roughly 660 not-yet-viewed items are already ready,
and resumes as you scroll. The source row says **more available**, **retrying**,
**rate limited**, **stale**, or **complete** so a protective pause is not
mistaken for a provider failure. **Check again** restarts completed finite
catalogs and immediately retries eligible sources.

## Appearance

Settings includes **System**, **Dark · Teal**, **Light**, **Midnight · Blue**,
**Forest · Green**, **Ember · Orange**, and **Amethyst · Violet**. Changes apply
immediately and persist across launches. System follows the Windows light/dark
preference.

The native title bar follows the selected theme too. Windows 11 supports the
exact palette color; Windows 10 uses the matching dark or light caption style.

## Playback

Video plays in a movable overlay with fullscreen support.

![Fullscreen TV - live IPTV from iptv-org](screenshots/4.PNG)

![Fullscreen video - NASA Image and Video Library](screenshots/5.PNG)

## Download, Record, And Equalize

- Finite originals expose **Download** and are written atomically to the
  `downloads` folder beside `WorldMediaWindows.exe`.
- Live radio and TV expose **Record**. Audio is finalized as MP3; video is
  finalized as H.264/AAC MP4. Recording reads the live source independently,
  so pausing, muting, changing volume, or adjusting EQ does not pause or alter
  the saved file. **Stop recording** performs finalization before publishing the
  completed filename.
- Settings provides Compact (96 kbps/480p), Balanced (160 kbps/720p), and High
  (256 kbps/1080p) profiles. Source resolution is never upscaled.
- The ten-band EQ and preamp apply immediately. The current curve is the global
  default; a favorite automatically keeps its own curve. There is no Apply or
  Save button.

Only download or record media when its source and your local law permit it.
World Media does not remove DRM or grant rights to third-party broadcasts.

## Where The Content Comes From

Every item World Media surfaces comes from one of eleven public archives or
directories. The app does not host content and does not require API keys.

| Source | What it provides | Home | Licensing |
|---|---|---|---|
| [Radio Browser](https://www.radio-browser.info) | Internet radio stations | `radio-browser.info` | Stations retain their own broadcast rights |
| [iptv-org](https://iptv-org.github.io) | Free-to-air IPTV channels | `iptv-org.github.io` | Stream operators retain their own rights |
| [Internet Archive](https://archive.org) | Films, recordings, books, and other media | `archive.org` | Per item, often public domain or Creative Commons |
| [NASA Image and Video Library](https://images.nasa.gov) | Mission photos, videos, and audio | `images.nasa.gov` | Public domain for U.S. government work |
| [Wikimedia Commons](https://commons.wikimedia.org) | Free-licensed media files | `commons.wikimedia.org` | CC-BY-SA or public domain per file |
| [LibriVox](https://librivox.org) | Public-domain audiobooks | `librivox.org` | Public domain |
| [media.ccc.de](https://media.ccc.de) | Technical conference recordings and current C3VOC streams | `media.ccc.de` | Per recording or event |
| [Library of Congress](https://www.loc.gov) | U.S. cultural-heritage audio and film/video | `loc.gov` | Per item and collection |
| [gPodder](https://gpodder.net) | Open podcast directory resolved through publisher feeds | `gpodder.net` | Publisher terms per episode |
| [PeerTube](https://joinpeertube.org) | Federated on-demand and live video | Independent instances | Per video and instance |
| [Owncast](https://owncast.online) | Independent self-hosted live video | Independent servers | Broadcaster terms |

## Privacy And Runtime Model

- **No accounts.** Nothing to sign up for.
- **No telemetry.** The app does not collect usage data.
- **No API keys.** All eleven sources use public anonymous endpoints.
- **Localhost only.** The bundled Python server binds to `127.0.0.1`.
- **Two bounded same-origin relays.** Catalog metadata uses an HTTPS-only,
  DNS-pinned allowlist proxy. Playback and capture use opaque expiring relay
  IDs, including rewritten HLS and DASH child resources. Upstream URLs and
  required playback headers are not exposed through control routes or logs.
- **No Linux child.** This build has no WSL distro, no rootfs image, no Docker
  image, and no setup script.

## Content Preference And Provider Limits

Explicit/NSFW content is off by default. It can be enabled only with the
**Show explicit/NSFW content** switch in Settings. Marked items are then shown
with a visible label; enabling the switch does not weaken URL, redirect,
private-network, schema, or media-safety checks. Turning it off hides marked
items everywhere while retaining saved favorites as nonrevealing placeholders.

Public catalogs are not equally reliable. Library of Congress may return a
CAPTCHA or 429 even below its published limit; the app retains the cursor and
backs off instead of reporting a false zero. Podcast feeds and independent
PeerTube/Owncast servers may be dead, slow, or malformed; one failure is
isolated from the other sources. C3VOC and Owncast are live snapshots that
refresh, and an empty C3VOC snapshot between events is valid. A provider marked
**complete** has reached the end of the current finite catalog; live snapshots
continue on their own refresh schedule.

The exact public endpoints, cache/refresh rules, and source-specific limits are
documented in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Troubleshooting

- If discovery says it is paused, scroll toward the bottom of the current
  results; fetching resumes automatically. Use **Load more** for an immediate
  user-priority request.
- **Retrying**, **rate limited**, or **stale** means the cursor and last verified
  data were preserved. **Retry now** is safe and does not create duplicate work.
- A playable item can still lack Download when the provider restricts it or
  exposes only a stream. Live media uses Record after a capable FFmpeg pair is
  detected or installed from Settings.
- An empty or broken independent stream is an upstream condition. **Try next**
  moves on without deleting the item or favorite.
- Runtime diagnostics are under `WorldMediaWindows-data\logs\` beside the
  launcher and do
  not contain upstream media URLs or authentication secrets.

## Requirements

- Windows 10 22H2 or Windows 11 (64-bit)
- Microsoft Edge WebView2 Runtime
- Internet access for upstream catalogs and streams

## Build From Source

```powershell
npm install
npm test
npm run build
python -m pip install --cache-dir .\build\local-cache\pip -r requirements-build.txt
python .\build_single_exe.py --skip-frontend
python .\build_windows.py --skip-frontend
```

The output is:

```text
dist\WorldMediaWindows.exe
dist\WorldMediaWindows\WorldMediaWindows.exe
dist\WorldMediaWindows-0.1.2-portable.zip
```

See [docs/BUILD_WINDOWS.md](docs/BUILD_WINDOWS.md) for the full build and smoke
test flow.

## License

MIT. See [LICENSE](LICENSE). Content from the listed sources retains its
original license.

### Bundled DASH playback library

MPEG-DASH playback uses [dash.js 5.2.0](https://github.com/Dash-Industry-Forum/dash.js),
bundled into the frontend under its
[BSD 3-Clause license](https://github.com/Dash-Industry-Forum/dash.js/blob/v5.2.0/LICENSE.md).
DRM-protected MPDs are rejected with an explicit unsupported response; World
Media does not request licenses or accept browser-provided license endpoints.

HLS playback uses vendored
[hls.js 1.5.13](https://github.com/video-dev/hls.js/tree/v1.5.13) under the
[Apache License 2.0](https://github.com/video-dev/hls.js/blob/v1.5.13/LICENSE).
The packaged app exposes its complete third-party notice at
`/THIRD_PARTY_NOTICES.txt` on its localhost runtime.

### Optional FFmpeg recording tool

World Media does not bundle FFmpeg in its EXE. Recording features can use an
existing capable `ffmpeg`/`ffprobe` pair or, after explicit confirmation, install
the exact `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` asset from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). The managed archive
is downloaded without administrator access, checked against GitHub's SHA-256
digest, inspected before extraction, capability-probed in staging, and only then
selected atomically. Its license files, install manifest, and `SOURCE.txt` are
retained beside the managed binaries. FFmpeg licensing details are available at
[ffmpeg.org/legal.html](https://ffmpeg.org/legal.html).

The normal unit suite uses small local fixtures. The full current-provider smoke
is intentionally opt-in because it downloads more than 160 MB:

```powershell
$env:WORLDMEDIA_FFMPEG_INTEGRATION = "1"
python .\tests_python\ffmpeg_real_integration.py
Remove-Item Env:WORLDMEDIA_FFMPEG_INTEGRATION
```
