# Troubleshooting and recovery

## First checks

1. Confirm the app is running from the intended EXE and data directory.
2. Open Settings and read the runtime paths, current/next server port, and
   FFmpeg status.
3. Check `WorldMediaWindows-data\logs\native.log` after closing the app. Logs
   redact upstream media URLs and secrets.
4. Retry the smallest affected operation: source **Retry now**, player **Play**,
   capture **Retry**, or FFmpeg **Repair**.

Do not clear the cache first. It deletes favorites, favorites categories, the
names you gave your favorites, preferences, EQ, the song log, starred songs,
and job history.

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

Since v0.1.11, on Windows a second copy of World Media cannot share a port that
the first copy is using (before, both could listen and the page's requests were
split between them). At start, if the usual port is busy and the program holding
it answers as World Media, the new copy waits up to 8 seconds before it tries
another port, because another port would be another browser origin with other
saved favorites. It cannot tell whether that copy is closing, so the wait
covers a copy that was just closed (it keeps its port for a few seconds) and
one that is still running. If another program holds the port, the new copy
moves to a fallback port at once. The line that starts with `listening` in
`native.log` shows the port, the process id and a short note on how the port
was chosen.

## Starting World Media a second time

Since v0.1.16 only one copy runs per data folder. Starting the app again while
it runs with the same `WorldMediaWindows-data` folder brings the open window to
the front (and restores it if it was minimized) instead of opening a second
window and a second server. The one-file EXE needs a few seconds before it can
hand over, because it unpacks first. A start made at the very moment the open
window is closing may open nothing; start the app again. A copy with another
data folder, such as a second portable folder, runs beside this one. A start
without a window (`WORLDMEDIA_NO_BROWSER=1`) on a folder that is in use exits at
once with code 3 and starts no server. After a crash or a killed process the
next start opens normally.

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

## A favorite station is not on the Tuner dial

The Tuner shows the favorites saved as the type you are on: radio stations on
the **Radio** dial and TV channels on the **TV** dial. When some of your
favorites are saved as the other type, the status line says so, for example "3
more saved as TV (switch to TV to see them)". Switch the band to see them.

This usually happens with a station from your own playlist whose address does
not say radio or TV. It is saved as the type of the playlist's **Add as**
choice. Since v0.1.11 **Add as** starts on **Auto**, which uses the type that
most channels in the same file say. When some channels needed a type from
**Add as**, the import result says how many and, with Auto, what it chose. To
change a station's type, choose the other **Add as** and import the
playlist again under the same file name. Its favorites move to the new channel
and keep their place, category and equalizer. If a favorite stays behind, check
that the channel's name did not change, and that the new channel is not already
a favorite.

## The Tuner says the stations could not be loaded

A live source did not answer within 20 seconds; the Tuner's status line counts
it as unavailable. Press **Radio** or **TV** above the dial to load the list
again. Public directories are slow at times, so wait a moment between tries.
"No stations found for this country." means the sources answered and have no
station for the chosen country; choose **All countries** or another one.

## My Playlists is empty or shows an error

If the saved playlists could not be read when the app started, for example
because the local server was still busy, My Playlists says "Your playlists could
not be loaded" and why. Since v0.1.11 the read is tried again each time you open
My Playlists, so open it again. If it keeps failing, check `native.log` (it
notes how many playlists and channels were listed or saved, never names or
addresses) and that `WorldMediaWindows-data\state\playlists.json` exists and can
be read.

An import can also skip entries on purpose. The result says how many entries
were skipped because they point at this computer or a private network address,
and why, and counts unsupported entries and duplicates.

## A JSON or CSV playlist is not imported

Since v0.1.12 **My Playlists** reads `.json` and `.csv` channel lists. When one
cannot be read, the message says why. The usual causes:

- "This JSON playlist could not be read. The file is not valid JSON (line ...,
  column ...)." The file has a typing error near that place, such as a missing
  comma or quotation mark. Open it in a text editor and fix it there.
- "This JSON file has no list of stations." The file must be a list of
  entries, or an object with a `stations` or `channels` list, and each entry
  needs a `url`.
- "No entry in this JSON playlist has a stream address." The entries have no
  `url` (or a similar name such as `stream_url`).
- "This CSV playlist has no column for the stream address." The first row must
  name the columns, and one of them must be `url`.
- "Near line ..., a value in quotation marks is never closed." A CSV value that
  starts with a quotation mark must end with one.
- A file over 8 MiB or with more than 50,000 entries is refused; split it into
  smaller files.

[Using the application](02-using-the-application.md#import-your-own-channel-playlists)
says what a JSON and a CSV list must look like.

## Catalog stopped, counts vanished, or a source says Wait

The labels are state, not final failure:

- **Pull** means the source has more work.
- **Wait** means transport/timeout/429/5xx or provider cooldown; the cursor is
  retained and exponential backoff is active.
- **Stale** means a prior live snapshot is still being used.
- **Done** means only that the finite cursor reached its end.

Since v0.1.15 a source whose page fails twice in a row, without the provider
saying when to try again, is tried again by itself every few minutes (after
one minute, then two, four and eight, then every ten). Its page says, for
example, "LibriVox is not answering", the line under it offers **Retry now**,
and the sidebar shows **Wait**. Use **Retry now** to try at once. When the
connection has dropped and comes back, World Media notices within about half a
minute and asks the waiting sources again by itself. In the Tuner and the
Grid, a source that could not be loaded is tried again by itself after 15
seconds, then after a minute, then every five minutes, and at once when the
connection comes back; the other sources stay in the list meanwhile. A large
catalog such as LibriVox arrives 30 items at a time, one request after
another, so its count grows steadily while it shows **Pull**; that is normal
collecting. Radio Browser arrives 300 stations at a time. Owncast and the
media.ccc.de live rooms are read once at start whichever view is open, so
their counts no longer stay at 0 while you look at Favorites or Radio. Use **Check again** after all
finite sources show Done. Scroll near the bottom or press **Load more** when the
rendered window is ahead of the active fetch. Disable a provider in Settings if
it is persistently rate-limited, then re-enable it later.

Library search and browse lanes are independent. A slow archive request, dead
podcast feed, or offline Owncast server must not retire the other
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

## My own station picture does not show

Pictures in the `station-images` folder (Settings → Station images → **Open
folder**) are matched by file name. Check:

- The file name, without its extension, must be the station's name. Capital
  letters and extra spaces do not matter. A longer or different name does not
  match.
- Windows does not allow `\ / : * ? " < > |` in file names. For a station whose
  name has one of them, write each one in the file name as `-`, `_` or a space,
  or leave it out. `Nu-Metal-Alternative.png` works for `Nu-Metal/Alternative`,
  and `ACDC Radio.png` or `AC-DC Radio.png` for `AC/DC Radio`. A name Windows
  keeps for itself (`CON`, `AUX`, `NUL`, `COM1`, `LPT1` and so on) takes a `_`
  or `-` at the end, such as `AUX_.png`. The rule is also shown in **Settings >
  Station images**. Before v0.1.11 only leaving the character out worked.
- Press **Refresh** under Station images. World Media looks at the folder when
  it starts and when you press **Refresh**, not while you add files.
- Read the line under the buttons. It says how many pictures were found and
  why files were ignored, for example `1 ignored: too large.`
- Read **Pictures to check**, the list under that line. It names each file that
  was not used, with the reason, such as "too large (the limit is 2 MB)" or "SVG
  is not allowed". It also names a picture that fits more than one station,
  and a picture that no favorite or playlist station is named like, which
  usually means the name has a typo. It shows ten lines and then "and N more".
- Only PNG, JPG, WebP and GIF files up to 2 MB are used, and each must be a
  real picture of that kind. An SVG, or a file of another kind that was
  renamed, is ignored.
- Only plain files directly in the folder are used. Files in a subfolder and
  shortcuts are ignored.
- If two files match the same station, the one whose name sorts first is used.
- A picture that is not square is shown whole, with plain space beside or
  above it. This is on purpose (since v0.1.10): nothing of it is cut off. For
  a picture that fills the box, use a square one.
- On the Tuner's station cards, pictures show only with **Settings >
  Appearance > Tuner card size** set to Medium or Large, and only once the
  dial has stopped turning.

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

## A stream under Other streams does not play

**Other streams** (in the detail panel of a Radio Browser station) lists other
directory entries with the same station name and homepage. World Media does
not test them before it lists them, and only **Pick the best stream** set to
**Auto (verified)** switches to one for you, after its checks. An entry can be
dead at its provider like any other station. Try another entry in the list, or
go back to the first stream. One station name can also cover different
channels, so an entry may be a different mix of the same station.

## Auto (verified) never finds a better stream

**Pick the best stream: Auto (verified)** moves a radio station to another
directory entry only when two checks a few minutes apart each found both
streams playing the same song, a different song each time. Read the line under
the stream details in the station's detail panel:

- **Better stream: could not be verified (this station sends no song titles)**:
  only a station that announces song titles can be verified. Any other keeps
  its own stream, and nothing is wrong.
- **Better stream: none found**: the directory has no other entry of the same
  station (same name, homepage, country and stream site) that is better and
  has been in the directory, unchanged, long enough.
- **Better stream: one match so far, checking again later**: the second check
  comes a few minutes later, while you listen or at a later play.
- **Better stream: could not be verified**: a check failed, for example
  because the other stream did not answer, played another song, or said a
  different station name. It is tried again after a day.

The first check waits for about 45 seconds of playing, counted from when the
sound starts. Pausing, changing station or choosing another setting stops a
check on its way. A verified stream is used from the next start of the station,
not while it plays. Only Radio Browser stations are checked; items from your own
playlists keep their own stream.

## A station plays another station's program

If a station plays what sounds like another station, for example a news
service, while its card shows the right name and picture, check the station's
own schedule first. Many stations carry another broadcaster's program at some
hours, such as a world news service overnight, and they send it on their own
stream. World Media plays the streams the station's directory entry or your
playlist entry gives. Only with **Pick the best stream** on **Auto
(verified)** can another directory entry of the same station play instead;
the detail panel then says **Better stream: ..., verified**, and **Use the
station's own stream** goes back to the station's own stream.

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

## "Connection lost" in the player bar

A live stream that was playing and then lost its connection is retried by
itself, for up to ten minutes. The player bar says:

| Text | Meaning |
|---|---|
| **Connection lost. Retrying...** | World Media is waiting for the next attempt, or making one. |
| **Can't reconnect. Press Play.** | Ten minutes passed without success. The station may be offline. Press **Play** to try again, or use **Try next**. |
| **Connection lost. Press Play.** | You paused while it was retrying. **Play** tries again at once. |

A station that never started playing is not retried. It shows the usual error.
A stream that freezes without any error is restarted after about 20 seconds.
Since v0.1.12 a live station whose connection is closed by the station is
retried in the same way; before, it stopped and showed **Play**.

## No song title appears

The title under the station name comes from the station, so there are a few
reasons for none:

- The station does not send titles. Many do not. Nothing is added to the Song
  log for them.
- The station is delivered as HLS. Titles are only read from streams that are
  played directly.
- The station sends a jingle name, an advertisement or filler text instead of
  the song. World Media shows what the station sends.
- A title can take a few seconds to appear, and again to change.

## A station shows no format or bitrate

A station shows its stream format and bitrate in its tooltip and in its details,
and on its card with **Show technical source details** on.

- Radio Browser lists them for its stations. Any other station shows them after
  it has played once; before that, nothing is known.
- A station delivered as HLS shows none, and neither does a station whose
  server sends neither an audio type nor a bitrate.
- **Clear local cache** removes what the app remembered, so the stations show
  nothing again until they play.
- With **Show technical source details** off, the card itself shows nothing, but
  the tooltip and the details still do.

## The sound meter does not move

The bars beside **EQ** in the player bar move only while sound is playing:

- They rest while playback is paused or stopped, while the sound is muted or
  the volume is at zero.
- Check **Settings > Appearance > Sound meter in the player bar**. When it is
  off, the meter is not shown at all.
- The meter also stays still when Windows is set to show fewer animations.
- In a window wider than 1000 px the meter sits in the progress row and is
  left out when that row has no room for it beside a usable seek slider. Make
  the window wider.
- Flat bars while you can hear the station mean the sound is not going through
  World Media's audio engine, for example when the stream had to be played
  directly because the local relay could not be used. The EQ is unavailable
  then too. Press Stop and Play to try the relay again.

## The Visualizer is slow, does not move, or shows a message

See [Visualizer](09-visualizer.md) for every control. Common causes:

- **The picture is still.** Check that something is playing and that the sound
  is not muted or at zero. The Visualizer reads the sound like the sound meter,
  so if the meter is flat, the picture has no sound to follow either (see the
  section above). With no sound it moves slowly for about 20 seconds and then
  holds still. It is also still until you press **Continue** on the notice (or
  **Start the Visualizer** after **Not now**), and when Windows is set to show
  fewer animations ("Windows is set to reduce animations, so the picture stays
  still.").
- **"The visualizer needs WebGL graphics, which are not available on this
  computer right now."** The Visualizer draws with the graphics card. Update
  the graphics driver and restart World Media. A remote desktop session or a
  virtual machine without graphics acceleration may not offer WebGL.
- **"The graphics driver was reset. The picture comes back by itself when it is
  ready."** Wait a moment. If it does not come back, open another tab and then
  the Visualizer again.
- **The picture is jumpy or the computer is busy.** Set **Quality** to Low and
  **Frame rate** to 15 or 30, choose Light scenes (or set the shuffle's
  **Scenes** to **Light only**), and turn effects and overlays off. Keep
  **Settings > Processor use** at **Low**. Turn on **Show measured fps** to see
  the rate it gets. The automatic step-down does part of this for you when a
  scene cannot keep up, and says so at the bottom right.
- **The computer runs warmer or louder with the Visualizer.** At **Processor
  use** **Balanced** or **High** the Visualizer may use more of the processor
  and draw sharper pictures, so the computer may get warmer and its fans
  louder, and a laptop's battery may last less. Lower the **Limit**, or choose
  **Low** in **Settings > Processor use**; it takes effect at once. At
  Balanced and High the shuffle also takes heavy scenes, unless you chose
  **Scenes** by hand.
- **Very high is not in the Quality list.** It is offered only with
  **Processor use** at **Balanced** or **High**. At **Low** a saved Very high
  draws as High and is kept for later. A heavy scene can still draw at High
  while Very high is chosen; the line "This scene draws at High" says so.
- **You want it to stop using the computer.** Open another tab. Leaving the
  Visualizer stops all its work and gives the graphics back, so it costs
  nothing while it is closed.
- **The picture is too bright or too busy.** Turn the effects and overlays
  off, lower **Brightness**, or leave the tab. The flash limiter is always on
  and cannot be turned off.
- **The notice came back.** **Clear local cache** resets the Visualizer's
  choices, so the notice is shown again.

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

- Turn Recorder on and install/repair FFmpeg from Settings. With it off, the
  Record button says **Recorder off**; point at it to read where to turn it on.
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

## Backup does not work

- "Backup not made: your latest favorites and settings could not be saved
  first" means the copy in the data folder is not up to date, so no ZIP was
  written. Try again in a moment, and check free disk space.
- "The downloads folder is not available" means the backup ZIP has nowhere to
  go. The ZIP is written to the `downloads` folder beside the app; check in
  Settings that it is writable.
- There is no restore button. See [Data, cache, and
  portability](05-data-cache-and-portability.md) for how to copy a backup back.

## Shutdown does not finish

Shutdown is terminal and gives catalog, asset, media, jobs, downloads, and
FFmpeg workers a bounded grace period. Starting with v0.1.3, the server
acknowledges promptly and finishes cleanup in the background. An accepted
request does not show Retry just because window cleanup failed. A stream or
provider socket can take a moment to release. If the request itself reports a retry:

1. Stop playback and active recording/download jobs from the UI.
2. Wait a few seconds and try Shutdown again.
3. If the window is unresponsive, close only the known World Media process from
   Task Manager/PowerShell, then relaunch and verify the profile.

Never delete `WorldMediaWindows-data` to solve a shutdown delay.

## Provider-specific symptoms

- **Radio Browser:** the app probes a public mirror and retries once with a new
  mirror if it dies. Individual station URLs remain community-maintained. An
  old Shoutcast server that answers "ICY 200 OK" instead of a normal web reply
  plays like any other station.
- **iptv-org:** try next candidate; logos and streams are separate data lanes.
- **Internet Archive:** metadata is rate-gated; retrying the same cursor is
  expected during an Archive brownout.
- **Library of Congress:** no longer in the app. Its site stopped answering
  apps (it asks for a browser check), so the source was removed. Saved items
  from it stay listed; one that cannot be played without the old source says
  "Source no longer available." in the player bar.
- **gPodder:** a directory result can point to a slow/dead publisher feed; the
  feed scheduler isolates that host.
- **PeerTube:** exact instance origins can return `Retry-After`; wait for the
  per-origin cooldown.
- **Owncast/C3VOC:** live snapshots may legitimately be empty or stale between
  events.
