# Installation and portable data

## Requirements

- Windows 10 22H2 or Windows 11, 64-bit.
- Microsoft Edge WebView2 Runtime (Evergreen x64).
- Internet access for public catalogs and streams.
- A writable folder for downloads, recordings, and optional managed FFmpeg.

The packaged application includes its Python runtime. End users do not need
Python, Node.js, Rust, Git, Docker, WSL, or a Linux distribution.

## Choose a package

### Classic one-file EXE

Run `WorldMediaWindows.exe`. The EXE extracts only transient startup files to
the Windows temporary directory and keeps persistent application state beside
it under `WorldMediaWindows-data`.

### Folder/ZIP portable package

Extract the complete archive and run the EXE inside the extracted folder. Keep
the folder contents together; the frontend, icon, and bundled runtime are part
of the package. This is the easiest form to move between drives and to keep as
a repeatable test installation.

The executable is unsigned. If Windows or antivirus software blocks it, verify
the file's provenance/checksum before allowing the containing folder.

## First launch

1. Place the EXE in a user-owned writable directory.
2. Double-click it and allow WebView2 to initialize.
3. The launcher selects a localhost port (normally `9124`), starts the Python
   server on `127.0.0.1`, and opens the native WebView2 window.
4. The adjacent `WorldMediaWindows-data` directories are created on demand.
5. Open Settings once to confirm runtime paths, writable status, and the
   current/next server port.

If a legacy `%LOCALAPPDATA%\WorldMediaWindows` profile exists and no portable
profile exists yet, the launcher copies the old state into the portable root
without deleting the original. This preserves favorites and EQ during a move.

## Moving from C: to E:

To move the app without losing favorites:

1. Use the app's Shutdown button and wait until the process has exited.
2. Copy the complete app folder and the adjacent `WorldMediaWindows-data`
   directory to the new drive.
3. Launch the EXE from the new location.
4. Confirm the Favorites count, Settings, downloads path, and FFmpeg status.
5. Keep the old copy as a backup until the new launch is verified.

Do not copy only the EXE while leaving the WebView2 data behind. The profile's
origin and browser storage contain the persisted favorites/settings/EQ state.

## Portable directory map

```text
<app folder>\
  WorldMediaWindows.exe
  frontend\                         packaged frontend (folder build)
  assets\                            icon/runtime assets (folder build)
  WorldMediaWindows-data\
    cache\                           bounded catalog/artwork cache
    state\                           launcher and profile handoff JSON
    logs\                            native/runtime logs
    webview2_data\                   WebView2 profile and localStorage
  downloads\                         finite downloads and recordings
  tools\ffmpeg\                     managed portable FFmpeg, if selected
```

The exact paths are displayed in Settings. A read-only portable root is not
silently repaired: downloads need a writable `downloads` folder, and managed
FFmpeg can be explicitly placed in `LocalAppData` instead.

## Port changes

The localhost port is part of the WebView2 origin. Settings therefore offers
**Save for next launch**, not a live rebind:

1. Enter a whole number from `1024` through `65535`.
2. Press **Save for next launch**.
3. Restart World Media.

The app normally uses `9124` and, when that port is occupied, tries a bounded
fallback range. The active process keeps its current port until it exits. The
profile handoff copies only the documented favorites/settings/volume/jobs/EQ
keys into `state\profile-preferences.json` before an origin change.

## Test portable installation

The repository's dedicated test launcher is:

```text
E:\WorldMediaWindows\dist\PortableTest\WorldMediaWindows.exe
```

Its persistent profile is:

```text
E:\WorldMediaWindows\dist\PortableTest\WorldMediaWindows-data\
```

Use this directory for rebuilt EXE verification. Keep its data profile intact;
replace the executable only after the old process has exited and verify the
Favorites count after launching the new build.
