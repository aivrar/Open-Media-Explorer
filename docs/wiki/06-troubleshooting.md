# Troubleshooting and recovery

## First checks

1. Confirm the app is running from the intended EXE and data directory.
2. Open Settings and read the runtime paths, current/next server port, and
   FFmpeg status.
3. Check `WorldMediaWindows-data\logs\native.log` after closing the app. Logs
   redact upstream media URLs and secrets.
4. Retry the smallest affected operation: source **Retry now**, player **Play**,
   capture **Retry**, or FFmpeg **Repair**.

Do not clear the cache first. It deletes favorites, preferences, EQ, and job
history.

## App will not start

- Install or repair Microsoft Edge WebView2 Runtime (Evergreen x64).
- Keep the entire folder build together; do not run a copied EXE without its
  packaged frontend/assets.
- If antivirus quarantines the unsigned classic EXE, allow the file/folder only
  after verifying its checksum and provenance.
- Check that the executable's directory is readable and that the adjacent data
  directory can be created.
- If a previous process is still running, close it from its original window or
  end only that known World Media process before launching the test copy.

## Port conflict or a blank window

The default local port is `9124`. If it is occupied, the launcher tries its
configured port and a bounded fallback range. To choose another persistent port:

1. Open Settings → Local server.
2. Enter `1024`–`65535` and press **Save for next launch**.
3. Close/restart World Media.

The current process does not jump ports while it is running. A blank WebView
usually means the local server did not start; inspect `native.log` for the
binding error and confirm the next-launch port.

## Favorites or settings appear missing

Usually the app is using a different profile/origin, not that the records were
deleted. Check:

- the EXE directory;
- `WorldMediaWindows-data\webview2_data` and `state` timestamps;
- the port shown in Settings;
- whether a second copy is running from another drive.

Close both copies, restore the backed-up `WorldMediaWindows-data` directory,
then launch only the intended EXE. A port change should use the built-in profile
handoff; a complete directory copy is still the safest migration.

## Catalog stopped, counts vanished, or a source says Wait

The labels are state, not final failure:

- **Pull** means the source has more work.
- **Wait** means transport/timeout/429/5xx or provider cooldown; the cursor is
  retained and exponential backoff is active.
- **Stale** means a prior live snapshot is still being used.
- **Done** means only that the finite cursor reached its end.

Use **Retry now** for waiting sources. Use **Check again** after all finite
sources show Done. Scroll near the bottom or press **Load more** when the
rendered window is ahead of the active fetch. Disable a provider in Settings if
it is persistently rate-limited, then re-enable it later.

Library search and browse lanes are independent. A slow Library of Congress
request, dead podcast feed, or offline Owncast server must not retire the other
sources. Public providers can still be unavailable for hours; the app cannot
invent missing records.

## Thumbnails or Grid logos are blank

Artwork is lazy and passes through an opaque local asset relay. Check the
following before assuming the catalog is empty:

- wait for the card to enter the visible/prefetch region;
- stop active playback if you need the fastest artwork queue;
- switch modes and back to rebuild the visible window;
- use the provider's Source link to see whether the logo still exists;
- inspect `native.log` for relay/upstream errors.

The generic TV/radio placeholder is valid when a provider has no safe artwork,
when an image failed after bounded retries, or while lazy hydration is pending.
Grid mounts a tile before observing it so WebView2 receives the initial visibility
event; rebuilding from the current source includes this fix.

## Playback will not start

1. Press Play once more. A failed item rebuilds its relay/HLS/DASH session.
2. If **Try next** appears, use it to test the next validated candidate.
3. Stop, wait a moment, and start the item again if the origin ended a rolling
   playlist.
4. Check whether the provider's Source page is online.
5. If only EQ playback fails, open EQ and choose Bypass or restart the app; the
   player stops rather than silently producing muted audio.

For IPTV/PeerTube/Owncast/HLS, a directory record can outlive the broadcaster.
For finite video, a missing codec or unsupported DRM can make playback
unavailable even when the metadata card is valid.

## Playback is jumpy or stops after starting

Live streams compete with network and CPU resources. World Media lowers catalog
and artwork concurrency while playback is active, uses a bounded HLS startup
buffer, and can lower the HLS rendition after repeated stalls. Improve results by:

- stopping extra downloads/recordings;
- turning Recorder off when you do not need capture;
- using a lower source rendition when the provider exposes one;
- stopping and restarting the stream to rebuild a stale HLS session;
- letting the player remain active instead of rapidly switching many channels.

If the broadcaster's rolling window is missing segments, only the provider can
fix it. A successful connection is not a guarantee of continuous uptime.

## Download fails

- Confirm the item is finite/on-demand; live HLS/DASH exposes Record instead.
- Confirm the downloads path in Settings is writable.
- Check for an existing file with the same title; the app normally creates a
  collision-safe name, but a locked file can still fail.
- Retry after a transient 408/429/5xx. Invalid HTML, mismatched media type,
  truncation, or an oversized response is intentionally rejected.
- Look for completed files in the shown `downloads` directory, not beside a
  temporary one-file extraction directory.

## Recording does not start or will not stop

- Turn Recorder on and install/repair FFmpeg from Settings.
- Verify both `ffmpeg` and `ffprobe` are marked capable.
- Wait through **Preparing…** for a slow HLS manifest; preparation is bounded
  and cancellable.
- Use **Stop recording** and wait for **Finalizing…**. The file is not published
  until FFmpeg output is probed and validated.
- If shutdown reports a retry, wait for finalization once, then press Shutdown
  again. A failed shutdown request should not be used as a reason to delete
  profile data or kill an unrelated process.

Turning Recorder off requests an orderly stop/cancel once and prevents a retry
storm. Downloads and ordinary playback remain available.

## Shutdown does not finish

Shutdown is terminal and gives catalog, asset, media, jobs, downloads, and
FFmpeg workers a bounded grace period. A stream or provider socket can take a
moment to release. If the button reports a retry:

1. Stop playback and active recording/download jobs from the UI.
2. Wait a few seconds and try Shutdown again.
3. If the window is unresponsive, close only the known World Media process from
   Task Manager/PowerShell, then relaunch and verify the profile.

Never delete `WorldMediaWindows-data` to solve a shutdown delay.

## Provider-specific symptoms

- **Radio Browser:** the app probes a public mirror and retries once with a new
  mirror if it dies. Individual station URLs remain community-maintained.
- **iptv-org:** try next candidate; logos and streams are separate data lanes.
- **Internet Archive:** metadata is rate-gated; retrying the same cursor is
  expected during an Archive brownout.
- **Library of Congress:** CAPTCHA/429 can cause a long wait even below the
  published limit; do not hammer Retry now repeatedly.
- **gPodder:** a directory result can point to a slow/dead publisher feed; the
  feed scheduler isolates that host.
- **PeerTube:** exact instance origins can return `Retry-After`; wait for the
  per-origin cooldown.
- **Owncast/C3VOC:** live snapshots may legitimately be empty or stale between
  events.
