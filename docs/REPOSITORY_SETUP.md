# Repository Setup

This directory is the source for the public GitHub repository.

Suggested repository name:

```text
Open-Media-Explorer
```

Suggested repository description:

```text
Portable Windows app for internet radio, live TV, podcasts, public-domain films, archives, and independent streams from eleven public sources, with favorites, EQ, downloads, and live recording.
```

Suggested topics:

```text
windows desktop-app portable media-player internet-radio iptv podcasts public-domain internet-archive peertube owncast hls open-media local-first no-telemetry
```

## Repository Metadata

Keep the GitHub About description and topics aligned with the values above.
The website field should remain the stable latest-release page:

```text
https://github.com/aivrar/Open-Media-Explorer/releases/latest
```

## Release

```powershell
python .\build_windows.py
python .\build_single_exe.py --skip-frontend
git tag -a v0.1.2 -m "Open Media Explorer v0.1.2"
git push origin main
git push origin v0.1.2
gh release create v0.1.2 .\dist\WorldMediaWindows.exe `
  .\dist\WorldMediaWindows-0.1.2-portable.zip `
  --title "Open Media Explorer v0.1.2" `
  --notes-file .\docs\RELEASE_NOTES_0.1.2.md `
  --verify-tag
```
