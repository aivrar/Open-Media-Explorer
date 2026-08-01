# World Media Windows 0.1.2

This is the largest World Media Windows update yet: eleven concurrent public
media sources, stronger live playback, portable data, downloads, recording,
equalization, new themes, and a complete end-to-end guide.

## Highlights

- Adds media.ccc.de/C3VOC, Library of Congress, gPodder Podcasts, PeerTube, and
  Owncast alongside Radio Browser, iptv-org, Internet Archive, NASA, Wikimedia
  Commons, and LibriVox.
- Keeps independent source callers moving concurrently with fair scheduling,
  provider-specific pacing, retained cursors, retry backoff, and persistent
  cache support.
- Improves HLS and non-DRM DASH playback with stream candidate failover,
  buffering headroom, stall recovery, and playback priority over background
  catalog and artwork work.
- Adds live MP3/MP4 recording, finite-media downloads, managed FFmpeg support,
  and a ten-band EQ with global and favorite-specific presets.
- Adds System, Light, Dark Teal, Midnight Blue, Forest Green, Ember Orange, and
  Amethyst Violet themes, including matching native title-bar colors.
- Keeps favorites, settings, cache, logs, downloads, and tools in a portable
  `WorldMediaWindows-data` profile beside the executable.
- Adds a complete user, troubleshooting, architecture, and developer wiki.

## Download choices

- `WorldMediaWindows.exe` — classic single-file portable build.
- `WorldMediaWindows-0.1.2-portable.zip` — extract-all package using the signed
  official CPython launcher/runtime layout.

The classic EXE is not code-signed, so Windows or antivirus software may ask
for confirmation. Existing portable data is preserved when replacing only the
EXE; do not delete the neighboring `WorldMediaWindows-data` folder.

See [CHANGELOG.md](../CHANGELOG.md) for the full technical change list and
[the documentation home](wiki/README.md) for usage instructions.
