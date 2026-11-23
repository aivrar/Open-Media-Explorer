# Changelog

## 0.1.16 - 2026-11-23

A station's stream format and bitrate show for stations from any source once
they have played, live AAC stations on Shoutcast servers that failed on some
starts now start at a whole sound frame, the volume has a compact control, the
player bar is one row, the Tuner gets the mouse wheel over its station strip and
a strength control for the Visualizer behind it, and starting the app again
brings the open window to the front.

- **Stream format and bitrate on any station that has played (issue #6):**
  reported by TaxicabMessiah: with **Show technical source details** on, a
  station from a playlist showed no format and bitrate, because only Radio
  Browser lists them. The app now remembers the format and bitrate a station
  played with, as its own stream says them (the audio type of its reply and,
  when it sends one, its bitrate), for each station, once it has played for a
  second. They show as "Stream: AAC+ · 320 kbps" in the tooltip of a station in
  the Library and the Tuner, as a tag in the station's details and, with
  **Show technical source details** on, on the Library card and in a short form
  on the Tuner card (for example "AAC+ 320k · My Playlists"). What Radio
  Browser lists is shown as before; a played value only fills in what the
  listing leaves out. The values are kept on this computer in the browser
  storage (at most 1,000 stations), are not in backups, and **Clear local
  cache** removes them. The description of **Show technical source details**
  in Settings now says what it shows. A station shows its format and bitrate
  after it has played once, unless Radio Browser lists them; a station
  delivered as HLS does not get them this way.
- **Live AAC stations start at a whole sound frame (issue #6):** a Shoutcast
  server starts a new listener wherever its buffer is, often in the middle of a
  sound frame, and then the player could stop with a decode error. About one
  start in five or six of Radio Caprice - Trip Hop, the station from issue #6,
  failed this way; v0.1.14 and v0.1.15 did too. A live AAC stream now starts at
  its first whole frame: the first frame header that the next two headers
  confirm. The bytes before it are dropped and nothing else is changed; if no
  such frame is found within 64 KB or 1.5 seconds, the stream is passed on
  unchanged. A saved start that failed 3 times out of 3 in the window's browser
  engine played 3 times out of 3 with this change, and in the real window of
  the release build 12 of 12 starts of that station played.
- **Live audio starts a little sooner:** a live audio reply that comes without a
  length is now passed on as it arrives; before, the app waited until it had
  read 64 KiB. On four stations that take this path the first bytes came 0.3 to
  0.5 seconds sooner.
- **Compact volume control:** the volume slider is replaced by a control beside
  the speaker (mute) button: an up button, the volume as a number from 0 to 100,
  and a down button, in a narrow column (in a window 1000 px wide or narrower,
  in a row of its own: down, number, up). A click changes the volume by 1;
  holding a button repeats after a 0.4 second pause (about 14 steps in the first
  second); the mouse wheel over the control changes it by 2 per notch; with the control focused,
  the arrow keys change it by 1, Page Up and Page Down by 10, and Home and End
  set 0 and 100. The volume area of the bar is 69 px wide where the slider's
  was 138. Changing the volume or mute with a video's own controls now updates
  the bar's number and speaker icon and is saved, and a volume you set while the
  sleep timer fades the sound is kept when the timer is cancelled.
- **Tuner:** the mouse wheel over the strip of station cards under the dial moves
  one station per notch, like the wheel over the dial. A new **Visualizer:**
  control at the right of the Tuner's top bar (a down button, a number and an up
  button, the same kind of control as the volume) sets how strongly the
  Visualizer shows behind the Tuner, from 0 to 100. The default, 8, is the look
  it had before; 100 shows it at full strength. 0 turns **Show the Visualizer
  behind the Tuner** off and pressing up from 0 turns it on; the switch in
  Settings and the control follow each other, and turning the switch off in
  Settings keeps the level. Nothing is drawn until the notice about flashing
  pictures has been accepted, as before, and the flash limiter works at every
  level. Processor use measured the same at 8 and at 100.
- **Player bar in one row:** in a window wider than 1000 px the bar is one row
  with every control on one centre line, 74 px high where it was 96 (168 where
  it was 198 in a window 1000 px wide or narrower, where its rows are stacked).
  The line of text under the buttons is gone: why the **Record** button is
  unavailable is its hover text and its description for screen readers (with
  Recorder off, it says where to turn it on: Settings, Capture & storage), and
  a capture's progress, result or error shows beside the button. The **Open
  Settings** button that appeared beside it with Recorder off or after a failed
  capture is removed; the gear at the top opens Settings. A Record button that
  only carries a hint can still be reached with the keyboard.
- **One copy per data folder:** starting the app again while it runs with the
  same data folder brings the running window to the front (restored if it was
  minimized) and does not open a second window or a second server. Copies with
  different data folders, such as two portable folders, still run side by side.
  After a crash the next start opens normally. A start without a window
  (`WORLDMEDIA_NO_BROWSER=1`) on a data folder that is in use exits with code 3.
  The one-file EXE takes a few seconds before a second start hands over,
  because it unpacks first.

## 0.1.15 - 2026-11-21

Channels, stations and episodes load faster and keep loading through a poor
connection, more podcast episodes and recordings are listed and play, and the
README and wiki have new screenshots.

- **Radio stations load much faster:** the Library asks Radio Browser for 300
  stations in one request where it asked for 30. On the test connection it
  collected 14,700 stations in 104 seconds; v0.1.14 collected about 690 in the
  same time.
- **Lists are sent compressed:** the app asks the catalog providers for
  compressed answers. The three iptv-org files that make up the TV list are
  now 2.5 MB on the wire where they were 17.9 MB. Channel pictures for that
  list are fetched beside it, so the channels appear without waiting for them
  (at most six seconds).
- **A server with several addresses:** many servers have more than one
  address, and one of them can be dead or slow. The app tried them one after
  another and waited eight seconds on a dead one for every request, so a
  podcast file on such a server did not start within a minute. It now tries
  the addresses together, the older address type (IPv4) first, uses the first
  that connects, and remembers the one that answered for ten minutes. The same
  file now starts in about seven seconds, and a directory that sent 100
  stations in 4 to 18 seconds over one address type on the test connection is
  read in 1.3 seconds over the other.
- **After the connection drops:** a Library source that fails twice in a row
  is asked again by itself after one minute, then two, four and eight, then
  every ten minutes; its page says, for example, "LibriVox is not answering",
  with **Retry now**. When the connection comes back, the app notices within
  about half a minute and asks the waiting sources again at once. In the
  Tuner and the Grid, a source that could not be loaded is tried again after
  15 seconds, a minute, then every five minutes, and at once when the
  connection is back, while the other sources stay in the list. A podcast feed
  that fails for a passing reason is tried again instead of being left out
  until the next start.
- **Owncast and the media.ccc.de live rooms are listed from the start:** these
  two live lists were first fetched only while a Library view that includes
  them was open, so with the Library opened on Favorites or Radio they stayed
  at 0. They are now fetched at start whichever view is open, and refreshed,
  as before, only while they are shown.
- **More podcast episodes:** an episode was listed only when its file was MP3,
  MP4 video or HLS. Episodes published as M4A or AAC, Ogg Vorbis, Opus, FLAC,
  WAV, WebM, M4V and MOV are now listed and play, so a show that publishes
  only such files has episodes. An episode that offers several files still
  plays the one it played before. Larger feeds are read (up to 16 MiB and
  250,000 elements), and a feed with a style sheet line is no longer refused.
- **More recordings play:** a media.ccc.de talk whose only recordings are
  WebM, Opus or in another language than the talk's own now plays, and a talk
  whose video file carries two languages plays as video. The Internet Archive
  no longer picks an old Ogg Theora file over an MP4. Wikimedia Commons FLAC
  and Opus files are listed. A Radio Browser station with only its listed
  address, and a LibriVox book whose feed has no MP3, now play.
- **Downloads:** a sound file that its server labels as video (an M4A sent as
  `video/mp4`, sound-only WebM or Ogg) is downloaded when it begins the way
  that kind of file begins, and keeps its own file ending.
- **Other changes to loading:** at most four catalog requests are sent at a
  time, so a request's time limit is not used up waiting for a free
  connection; LibriVox pages are asked for without the extended details (0.4
  seconds a page where it was 1.1); the Radio Browser mirrors are checked at
  the same time and a mirror that failed is left out; the TV list is read
  again after six hours; a NASA page that comes back short is asked for again
  instead of ending the list; the Grid keeps the keyboard focus when its tiles
  are redrawn.
- **Screenshots:** the README and the wiki show the current application in 25
  new screenshots and four short GIF demos (`screenshots/v0.1.14/`); the old
  screenshots are removed.

## 0.1.14 - 2026-11-21

One fix for a report in issue #6: stations on an old Shoutcast server did not
play.

- **Old Shoutcast stations play:** an old Shoutcast server (version 1) starts
  its answer to a player with "ICY 200 OK" where a web server says
  "HTTP/1.0 200 OK". The app refused that first line, so such a station failed
  every time, whatever **Pick the best stream** was set to, although its
  address worked in a browser or another player. The app now reads that answer
  like any other: the station plays, shows its song titles, and can be
  recorded. Reported with Radio Caprice - Trip Hop.

## 0.1.13 - 2026-11-21

Five requests from discussion #8 (a Now Playing tab, a mark on stations that did
not play last time, station pictures from a file or a drop, a larger song
title, and no seek bar on live radio and TV), three fixes for dragging
favorites reported in issue #6, four more Visualizer scenes (103 in all) with
new overlays and blends, and other fixes.

- **Now Playing:** a new tab between **Discovery** and **Visualizer** shows what
  plays now, large: its picture (your own station picture if you have one, else
  its artwork, else its initials) over a blurred, dimmed copy of the picture,
  its name (your own name for a renamed favorite, with the original name under
  it) and, for a favorite, its category. A star beside the name adds it to or
  removes it from your favorites. For radio and other live audio, the song the
  station announces is shown in large type, with a star and **Copy**, or a line
  says that the station is not announcing a song title. **Stream details**
  lists the source, the type, the format and bitrate of the stream that plays,
  the country and language when known, the **Better stream** line when **Pick
  the best stream** is on **Auto (verified)**, and **Playing for**, the time it
  has played (only time with sound counts). Below the song, a large copy of
  the sound meter moves with the sound; **Sound meter in the player bar**
  switches only the small one. With nothing playing, the tab says so and offers
  **Open the Library** and **Open the Tuner**. Play, pause and stop stay in the
  player bar, and nothing in the tab runs while it is closed (discussion #8).
- **No seek bar on live radio and TV:** internet radio showed a seek bar that
  did nothing. A live station or channel now shows no seek bar and no length,
  and the time label shows how long it has played, starting at 0:00 (no dimmed
  bar with "--:--" first). A film, a podcast episode or a file keeps both, and
  so does an entry in your own playlist that turns out to be a file with a set
  length. A recording has its seek bar from the press of **Play**, dimmed until
  its length is known (discussion #8).
- **Larger song title:** on the player bar the song is larger, bolder and
  brighter than the rest of the line, and the song and the station name grow
  with the window (the song from 14 px in a 1024 px wide window to 22 px in one
  about 2,800 px wide or wider). The Tuner dial's station name grows too. On
  windows wider than 1000 px, a live station's song and name also take the room
  the seek bar had, and their column is wider on wide windows, so a long title
  is cut short less often (discussion #8).
- **Did not play last time:** a station of yours that did not play when you
  last tried it gets a small red **!** on its card in Favorites, My Playlists
  and the Tuner, and a line in its details. Pointing at the mark reads "Did not
  play last time (date). It is tried again when you play it." The mark never
  stops you from pressing Play, and it goes as soon as the station plays. Only
  favorites and My Playlists stations are marked. A failure caused by your
  connection, not the station, is not marked: nothing is marked while Windows
  reports no connection or when the station's address could not be looked up,
  and a station that could not be reached is marked only if something on the
  internet answered within the last minute or a small check (one short request
  to Radio Browser, at most once every 30 seconds) gets an answer. Stopping a
  station, or choosing another before it starts, is not a failure. The marks
  are kept only on this computer (at most 2,000) and are not in backups, and
  **Clear local cache** removes them (discussion #8).
- **Station pictures from a file or a drop:** **Choose picture...** in the
  details of a favorite or a My Playlists station, or dropping one picture file
  on its card in Favorites or My Playlists, gives the station a picture of your
  own. It takes PNG, JPG, WebP or GIF up to 2 MB and checks the file as it
  checks the `station-images` folder (an SVG or a file that is not really a
  picture is refused, with the reason), then saves a copy in that folder, named
  after the station. If a file is already there, you are asked before it is
  replaced, and the question names it. **Remove picture**, shown while the
  station has a picture of its own, asks first, names the file or files, and
  deletes only those. A picture dropped anywhere else changes nothing, and a
  message says where to drop it (discussion #8).
- **Dragging favorites** in **My order** (issue #6): a drag worked only about
  half the time unless the card was dropped picture onto picture, a "no entry"
  cursor flickered over the tag and **Move** buttons while dragging, and a card
  dropped on another landed one place too low. A drop anywhere on another card
  now puts the dragged card in that card's place and moves the cards between by
  one. The "no entry" cursor is gone, and a drop in a gap or on the card itself
  changes nothing.
- **Visualizer behind the Tuner:** **Settings > Appearance > Show the
  Visualizer behind the Tuner**, off by default, draws the Visualizer faintly
  behind the Tuner while sound plays. It starts only after the notice about
  flashing has been accepted in the Visualizer tab, draws light scenes only
  with no overlays or effects, and stops a few seconds after the sound stops
  and when you leave the Tuner. The flash limiter still applies.
- Visualizer: four more scenes, 103 in all (32 Light, 23 Medium, 48 Heavy): the
  3D flights DIFS Tunnel Flight and Quaternion Julia Flight, and the line
  drawings Fourier Epicycles and 4D Polytopes. Mandelbrot has two more looks,
  Neon and Ocean, with slower color cycling.
- Visualizer overlays: three new calm overlays, **Ripples**, **Fireflies** and
  **Orbits** (29 overlays in all).
- Visualizer blends: two more ways to blend an overlay into the scene.
  **Lighten** keeps whichever is brighter, the scene or the overlay. **Color**
  puts the overlay's color on the scene without changing how bright it is.
- Visualizer: **Extra glow (Medium and High quality)**, a switch under
  **Shuffle overlays**, off by default, spreads some of the overlays' light
  into a soft glow around them. It does nothing at Low quality.
- Visualizer: with **Slow drift** on, the size or spread of some overlays also
  drifts gently. Their colors and brightness never drift.
- Player bar: a station's logo is shown whole in the square and in the details
  panel (a wide logo used to be cut to its middle), and a logo with transparent
  parts no longer shows the station's initials behind it.
- Player bar: after a station failed to start, the record button is grayed out
  and the status line says "Recording is available once this item plays." A
  file in your own playlist is no longer called live in that line once its
  length is known: it says "This stream can be recorded."
- Player bar: a station whose address does not exist says "This station's
  address does not exist. Press Play to retry." An address that could not be
  looked up says "This stream's address could not be looked up. Check your
  internet connection, then press Play to retry." After a station failed to
  start, **Play** stays in the player bar and tries the station again.
- Sleep timer: the menu shows the choice that is running (a custom time too,
  such as "45 min") and goes back to **Off** when the timer ends or is
  cancelled. An empty or non-numeric custom answer starts nothing (it used to
  start a 6-second timer).
- Tuner and Grid: a refresh that fails keeps the stations a source had already
  listed, and the status line says that source could not be refreshed. When a
  failed source leaves the view empty, it tries again by itself, after about
  8 seconds and once more about 20 seconds after that, and says so.
- Visualizer: the **Music:** line (calm, steady or energetic) is read from the
  sound's spectrum instead of counting drum hits. It does not depend on how
  loud the sound is and changes little with the frame rate (at 15 frames a
  second a very fast, dense beat can read as steady).
- Visualizer: overlay lines and particles are drawn at the same size on the
  screen at every quality whose picture is at least 720 pixels tall. Lines are
  thicker at Medium and High than before.
- Visualizer: Fireworks, Lasers, Stage Lights, Lightning and Spectrum can no
  longer go under the effects (they still work over them), and the grayed
  **Under the effects** box says "Not available for this overlay." A line by
  the **Blend** choice says "Only one overlay can be blended in at a time."
  when choosing a blend sets another overlay back to plain.
- Visualizer: Voronoi Cells no longer takes the **Mirror** effect, the effect
  **Heat Haze & Caustic Light** is named **Heat Haze**, and the side panel is
  nearly opaque, so a bright scene does not show through behind its text.
- Favorites and My Playlists cards show a long name on two lines, and the whole
  name on hover. The empty star on a card now shows on light themes (it was
  white on a light card). With **Show technical source details** on, the Library
  sidebar puts each source's status label under its count, so a long source
  name has more room.
- Links on the About page and **What this means** in Settings use the app's
  link color, and the local port line in Settings uses the same small
  description text as the other settings.
- Library: **Retry now** asks a podcast feed that is waiting after a failure
  again at once. A feed the app refuses because of what the publisher sends
  (too large, too complex or unsafe) is otherwise asked about once in six
  hours.
- The names you gave stations that are no longer favorites, and the categories
  they were in, are cleared at start-up, so a station you star again shows its
  own name.
- Settings and playback: saving your favorites and settings no longer waits
  behind slow catalog loading. A save uses a connection of its own, and slow
  catalog lookups hold at most three connections at once, so a first start with
  a large catalog load is less likely to show "The portable profile backup
  could not be updated". Pressing **Play** no longer waits behind slow catalog
  loading to start the stream either.
- Artwork: a picture the app refuses because of its address is remembered, and
  not asked for again on every visit to the Grid.
- Tuner and Grid: one source is written in the singular ("Loading 1 live
  source..."), and the status line never says "from 0 sources".

## 0.1.12 - 2026-11-20

The five requests promised in discussion #8 (starred songs, your own station
names, drag to reorder, JSON and CSV playlists, and a better stream chosen for
you), a Processor use setting, 28 more Visualizer scenes, and fixes, two of
them for issue #6.

- Starred songs: star a song in the **Song log**, or the song playing now with
  the star beside it on the player bar. **Starred songs** in the Song log
  panel lists them, newest first, with the station and the time. Each one can
  be copied, looked up on the web or on YouTube in your browser, or unstarred.
  **Save as text** and **Save as CSV** write the list to a file. Up to 2,000
  are kept; starring one more removes the oldest, and the panel says which.
  They are kept apart from the song log, so **Clear log** leaves them, and
  they are in backups (discussion #8).
- Rename a station: **Rename** in a favorite's details gives it a name of your
  own, shown everywhere that favorite is: the Library, the Tuner's dial and
  cards, the player bar, the song log and starred songs. The details still
  show the original name, and **Use original name** brings it back. A renamed
  favorite is found in searches by either name, keeps the station picture
  named after the station, and is still matched to its other directory
  entries under the station's own name. It works for any favorite, radio or
  TV (discussion #8).
- Drag to reorder: in Favorites, with **My order**, a card can be dragged
  before or after another. **Move to top**, **Move up**, **Move down** and
  **Move to bottom** still work, also from the keyboard (discussion #8).
- JSON and CSV playlists: **My Playlists** imports `.json` and `.csv` channel
  lists, from a file, by dropping the file on the window, or from a web
  address. A JSON list is a list of entries with a `url` (or an object with a
  `stations` or `channels` list); a CSV list has a header row with a `url`
  column, and name, logo, group and type columns are used too. Comma,
  semicolon and tab are all read, and a CSV list without a header row is read
  too when its first row holds a web address. When a file cannot be read, the
  message says why, and for a broken file near which line (discussion #8).
- Pick the best stream (**Settings > Content**) has three choices
  (discussion #8):
  - **Listed streams** (the default): when a station or channel lists several
    streams, the best one is tried first (a larger picture for TV; for radio a
    higher bitrate up to 320 kbps, then the more efficient format). The next
    one is tried too if the best has not answered within six seconds, or at
    once if it fails. A stream that connects but never begins hands over to
    the streams not tried yet, at the latest after 30 seconds. A stream that
    has begun gets 10 seconds from when it started to play one full second
    before the next one is tried; after that, an interruption is handled by
    the usual reconnecting.
  - **Auto (verified)**: as Listed streams, and for a radio station also other
    Radio Browser entries of the same station. One is used, from the next
    start of that station, only after it is verified: two checks in the
    background, a few minutes apart, each found both streams playing the same
    song, a different song each time. So only a station that announces song
    titles can be verified; any other keeps its own stream. The first check
    waits for about 45 seconds of playing, counted from when the sound starts
    (and again after a pause). Pausing, changing station, or choosing another
    setting stops a check on its way. A line in the station's details says
    what the checks know so far (checking, one match so far, none found, or
    could not be verified). Once a better stream is verified it reads
    **Better stream: ..., verified. It is used from the next start.**, and
    **Use the station's own stream** is there at once; choosing it keeps the
    station's own stream and restarts nothing.
  - **Off**: as in earlier versions.
- Processor use (**Settings > Processor use**, and a new section on the About
  page): **Low**, the default, is how the app has always behaved. **Balanced**
  and **High** let the Visualizer use more of the processor, up to a limit you
  set from 2% to 80% of the whole processor (40% and 60% to start with); a
  number outside that range is corrected, and a note says so. While the
  Visualizer plays at those levels, the app checks every few seconds how much
  of the processor it uses: over the limit for a few seconds, the picture
  quality steps down; with plenty of room for a while, it steps back up,
  slowly. The limit is a target, not a hard cap: the sound is never held back
  to meet it. With a graphics card the Visualizer usually needs only a small
  share of the processor, so the limit matters most on computers without one
  or with few cores. At Balanced and High the shuffle's default **Scenes**
  choice includes heavy scenes too, and a line under it says so.
- Processor use, Balanced and High: **Quality** also offers **Very high**. It
  is sharper than High on a large screen, where High cannot draw every pixel;
  on a smaller one it looks the same. Light and Medium scenes, Mandelbox
  Flight, Curl-Noise Silk, Fluid Ink, Lenia and Physarum draw at Very high;
  the other heavy scenes stay at High, and the panel says so. At
  the High level, Curl-Noise Silk, Fluid Ink and Physarum start one size
  larger at High or Very high quality. The frame rate, the most effects and
  overlays at once (three of each), and the flash and brightness safety
  limits are the same at every level.
- Visualizer: 28 more scenes, 99 in all (32 Light, 23 Medium, 44 Heavy):
  - Line drawings: Hopf Fibration, Knots & Surfaces, Lissajous, Attractor
    Ribbons and Spirograph, glowing lines with trails.
  - Simulations: Curl-Noise Silk, Fluid Ink, Lenia, Physarum, Reaction-Diffusion
    and Feedback Loop, pictures that grow and flow from one frame to the next.
  - 3D flights: Apollonian Foam Flight, Folded Box Variants Flight, Mandelbox
    Flight, Triplex Mutation Flight and Glass Fractal DE Flight.
  - Labs and more: 2D Formula Lab, Analytic Field Lab, Procedural Field Lab,
    Fractal Flame Lab, Buddhabrot Lab, Cymatics and Robot Foundry.
  - Five scenes of World Media's own: Band Ridgelines, Sound Ring and Petal
    Bloom (in a new group, Sound Shapes), Hex Weave and Contour Lines. The
    music moves only their shapes, never their colors or brightness.
- Visualizer: Buddhabrot Lab builds its picture point by point for about a
  minute and then holds it. The cross-fade into it waits (up to four seconds)
  until its picture shows, so the screen does not go dark meanwhile.
- Visualizer: 28 more looks for three labs, one for each formula that no
  ready-made look showed:
  - 2D Formula Lab (16): Multibrot, Tricorn, Burning Ship, Burning Ship Julia,
    Perpendicular Mandelbrot, Perpendicular Burning Ship, Perpendicular
    Buffalo, Perpendicular Celtic, Phoenix, Magnet II, Cosine, Sine,
    Exponential, Lyapunov, Nova and Manowar.
  - Analytic Field Lab (2): Pentagrid Loom and Arnold Tongue Map.
  - Fractal Flame Lab (10): Linear + Spherical, Polar + Spherical,
    Handkerchief + Spherical, Heart + Spherical, Spiral + Spherical, Swirl +
    Linear, Swirl + Horseshoe, Swirl + Disc, Swirl + Julia and Swirl + Popcorn.
- Visualizer effect: **Palette Map** recolors the picture with a color scheme
  (39 effects in all).
- Visualizer overlay: **Strobe**, a soft colored pulse on the beat, picked by
  the shuffle only while the music is energetic. Its **Style** is Any, From
  the center, From the edges, Sweep or Halves, and the choice is kept with
  the other Visualizer settings (26 overlays in all).
- Visualizer: **Slow drift** (on by default, in the panel): between scene
  changes, a few settings of the scene and its effects move slowly in time
  with the music's bars, further when the music swells, and the overlays turn
  and sway slowly. It changes shape, size and color mixes, never brightness.
- Visualizer panel: each section (Scene, Shuffle, Effects, Overlays and
  Picture) has a title bar. A click, or Enter or Space, folds the section, and
  the bar says at the right what is set, for example "Medium, 30 fps". Folded
  sections stay folded next time. **Effects on** and **Overlays on** are
  always shown; the other effect and overlay controls show while their switch
  is on.
- Visualizer: the music's mood (calm, steady, energetic) is read more
  carefully. One drum stroke heard on several bands counts once, hi-hats
  alone count half, and the tempo adds energy only from 80 beats a minute, so
  a slow beat with busy hi-hats no longer reads as energetic. Music now reads
  as energetic from a lower energy than before (above 0.48, was 0.65), set
  from readings of seven stations of different styles.
- Visualizer: the **Music:** mood line in the panel is read out once when the
  panel opens, not at every change.
- Larger targets for the pointer: the Move buttons on Favorites cards in **My
  order** (now a 2 x 2 block) and the effect and overlay rows in the
  Visualizer panel.
- Library: the media.ccc.de live list is read again at most every five minutes
  (was every minute), and live lists (media.ccc.de and Owncast) are refreshed
  only while they are shown in the Library.
- Tuner: a long station name on the dial ends in an ellipsis and shows in full
  when the pointer rests on it.
- American spelling throughout, also in names that come from the Visualizer's
  scenes and effects (Watercolor, favorites, license).
- Backups also carry the names you gave your favorites, your starred songs and
  the stations you keep on their own stream.
- Player: a live station whose connection closed stayed silent with a **Play**
  button, with no message and no new try. It now says "Connection lost.
  Retrying..." and connects again, as for other dropped connections (found
  while looking into a report in issue #6).
- Favorites: with **Show technical source details** on, cards in **My order**
  in a wide window squeezed the source label (such as "MY PLAYLISTS") into a
  narrow box, where it wrapped. The cards are now wide enough for the label to
  show whole on one line (issue #6).
- Library: a catalog page that failed without the server saying when to try
  again was retried at once, again and again, with no wait and no limit. It now
  waits longer each time, and after two failures in a row the source stops
  loading by itself until you press **Retry now**.
- Tuner: when a live source did not answer in time and the dial stayed empty,
  it said "No stations found for this country." It now says the stations could
  not be loaded and that **Radio** or **TV** tries again. A Radio Browser
  directory server that stayed silent until the time limit is replaced by
  another at the next request.
- Library: a page a source refuses outright (for example PeerTube search past
  the deepest page its index serves) ends that listing instead of being asked
  for again.
- Library: a live list that fails to refresh is asked again after its usual
  wait (five minutes for media.ccc.de, two for Owncast), not every 30 seconds.
- Player: pressing **Play** after a stream had ended by itself now connects to
  the stream again, instead of trying to play the stream that had ended.
- Settings: a long description beside a switch could squeeze the switch to a
  dot; the switch now keeps its size and the text wraps. Buttons such as
  **Clear cache** stay on one line.
- A notice that "the portable profile backup could not be updated" could show
  on a first start, while the first catalog load was still busy: an automatic
  save that fails is now tried once more, quietly, before the notice is shown.
- Visualizer: when it cannot start, everything it had made is freed again.
  The mood starts fresh after another station, a resume or a gap in the sound,
  and keeps its last word until the new reading is ready.

## 0.1.11 - 2026-11-18

A new Visualizer tab, fixes for issue #6, and more requests from
discussion #8.

- Visualizer: a new tab between **Discovery** and **About** shows pictures that
  move with the sound of whatever is playing. It is ported from Psychedelia
  Studio, the author's own project
  (https://github.com/aivrar/psychedelia-studio). It has 71 scenes, from flat
  patterns to 3D scenes you fly through. A badge on each scene says how hard it
  works the graphics card: **Light**, **Medium** or **Heavy** (26, 21 and 24
  scenes). A scene with ready-made colour schemes has a **Look** choice. Work on
  the visualizer continues, and more is planned.
- Visualizer shuffle: changes the scene every 8, 16 or 32 bars of the music.
  **Scenes** chooses how heavy the scenes may be: **Light only**, **Light and
  medium** (the default) or **All, heavy too**. The shuffle can use all scenes
  or only your favourites, and it leans towards calmer scenes for calm music.
- Visualizer effects: 38 post effects can go over the picture. They are off by
  default. Pick up to three by hand, or let **Shuffle effects** pick them with
  each scene or every 4, 8 or 16 bars. **Strength** is Subtle, Normal or
  Strong.
- Visualizer overlays: 25 overlays (lasers, stage lights, fireworks, particles,
  matrix rain and more) can be drawn over the picture. They are off by
  default, up to three at a time, and can be shuffled. One of them can be
  blended in: with a blend mode (Add, Screen, Multiply, Soft light or
  Difference), under the effects, shown only in the bright or the dark areas
  of the scene, in the scene's colours, or bending the scene.
- Visualizer favourites: the star over the picture keeps the scene, its look,
  the effects and the overlays. The scene list has a **Favourites** filter,
  and the shuffle can use only your favourites. They are separate from your
  station favorites.
- Visualizer picture: **Quality** is Low, Medium (the default) or High, **Frame
  rate** is 15, 30 (the default) or 60, and **Brightness** goes from 30% to
  100%. **Show measured fps** shows the frame rate it really gets.
- Visualizer step-down: when the computer cannot keep up with a scene, the
  Visualizer lowers the load for that scene by itself: effects first, then
  overlays, then quality, then frame rate. A note says what changed. Your
  choices stay as they were, and effects and overlays that were held back stay
  ticked. The next scene starts at the chosen quality again, unless it needed
  less earlier in the same visit.
- Visualizer safety: a notice about flashing and photosensitivity comes before
  the first picture moves, and again from **About flashing and
  photosensitivity** in the panel. A flash limiter is always on. It keeps light
  pulses to at most three a second and fades between scenes. It cannot rule
  out every risk.
- The Visualizer costs nothing while its tab is closed, and it never changes
  the sound: it only reads it, as the sound meter does.
- Credits: the shader code the Visualizer borrows from others is credited under
  **Visualizer credits** on the About page, in `CREDITS.md` and in the
  packaged third-party notices.
- Playlist import: **Add as** starts on **Auto**. Auto gives a channel that does
  not say radio or TV the type most channels in the same file say, or TV when
  the file does not decide. When some channels needed a type from **Add as**,
  the import result says how many and, with Auto, what it chose and why. When
  every channel says its own type, there is nothing to report. **TV** and
  **Radio** work as before (issue #6).
- Playlist import: importing the same playlist again with another type, for
  example as **Radio**, moves the favorites of the channels whose type changed
  (here from TV to radio) to the new channel, with their place in My order,
  their category and their own equalizer curve. Before, they stayed behind as
  TV favorites that the radio dial never showed (issue #6).
- Playlist import: the result now says how many entries were skipped because
  they point at this computer or a private network address, and why. Two
  entries with the same address but different names are both kept (issue #6).
- My Playlists: a first read of the saved playlists that failed (for example
  just after the app started) is tried again each time My Playlists is opened,
  instead of leaving the list empty until you restart (issue #6).
- Tuner: when some of your favorites are saved as the other type, the status
  line says so, for example "3 more saved as TV (switch to TV to see them)",
  instead of the stations silently missing from the dial (issue #6).
- Player bar: the bar no longer jumps sideways on every station change. The
  **Play** button was hidden for a moment, which narrowed the buttons (issue #6).
- Channels from your own playlists no longer show "See provider terms" on their
  cards and detail panel. Other sources keep their notes (issue #6).
- Station images: a station whose name has a character a file name cannot have
  (`\ / : * ? " < > |`), for example "Nu-Metal/Alternative", now matches a
  picture in which each such character is written as `-`, `_` or a space, or
  left out. The rule is shown in **Settings > Station images**
  (discussion #8).
- Station images: Settings lists the pictures that were not used at the last
  scan and why (too large, not a valid picture, an SVG, a second picture with
  the same name, and so on). It also lists a picture that fits more than one
  station, and a picture that no favorite or playlist station is named like
  (discussion #8).
- Favorites: in My order, each card has a fourth button, **Move to bottom**
  (discussion #8).
- Favorites: **Remove all favorites** asks first, with the number of favorites
  and a hint to use **Back up my data**. It also removes the favorites' own
  equalizer curves (discussion #8).
- The playlist and favorites controls now say how to remove and change
  stations: a note on **Import playlist** and **Remove playlist**, and a clearer
  message when no playlist is chosen (discussion #8).
- Windows: a second copy of World Media can no longer share the first copy's
  local port, which split the page's requests between the two. If the usual
  port is busy and answers as World Media, the new copy waits up to 8 seconds
  before it tries another port. This covers a copy that was just closed and one
  that is still running.
- Tuner: station initials of four letters, such as "SWR3", are no longer cut
  off on Medium and Large cards.
- Light theme: the seek and volume slider tracks in the player bar are now
  visible. They were almost the colour of the bar.
- The status line under the player bar no longer cuts the tails of letters such
  as g, y and p.
- The "0 dB" label in the EQ graph sits above the line instead of across it.
- Internal: the Visualizer's choices are stored inside the existing settings.
- Internal: `native.log` notes how many playlists and channels were listed or
  saved (counts only, no names or addresses), and tells two copies apart by
  process id.

## 0.1.10 - 2026-11-16

Fixes for issue #6 and three more requests from discussion #8.

- Your own station pictures that are not square were cut off at the sides or
  at the top and bottom. They are now shown whole and centred, on a plain
  background, in the player bar, the Library cards, the detail panel, Discovery
  and the Tuner cards. Other artwork is shown as before (issue #6).
- Tuner: the dial no longer grows and shrinks by a few pixels on some stations.
  A station name in another script, for example Chinese, made its card 2 px
  taller; all cards now have a fixed height (issue #6).
- Tuner: the dial no longer becomes smaller the first time something is played
  after starting the app. The Tuner now keeps room for the player bar before
  the first play, so the dial has the same size before and after (issue #6).
- Tuner: the dial no longer jumps when the strip under it shows a message
  instead of cards, for example while stations load or when none are found.
  The strip keeps its height (issue #6).
- Sound meter: small LED-style bars beside **EQ** in the player bar move with
  the sound, so you can see that a station is really playing. 14 bars, from
  about 40 Hz to 16 kHz. The meter only reads the sound and never changes it.
  It rests completely while playback is paused or stopped, muted or at volume
  0, and slows to about one update a second while the window is minimised.
  **Settings > Appearance > Sound meter
  in the player bar** switches it; it is on by default. In a window up to
  1000 px wide it sits at the end of the button row (discussion #8).
- Tuner: the knob shows only the station's name. The source (for example
  "My Playlist") is no longer added after it; it is still on the station's card
  in the strip (discussion #8).
- Tuner card size: **Settings > Appearance > Tuner card size** offers
  **Small** (as before, the default), **Medium** and **Large**. Medium and
  Large cards are bigger and show the station's picture: your own station
  picture, otherwise the station's logo, otherwise its initials. Pictures load
  only for the cards you can see, after the strip stops moving
  (discussion #8).
- Internal: the two new choices are stored inside the existing settings, so
  going back to v0.1.9 keeps your favorites and settings.
- Internal: a Python relay test that sometimes failed on a busy machine now
  waits long enough, and a new test covers a short pause in a stream.

## 0.1.9 - 2026-11-15

Most of this release answers the feature requests in discussion #8.

- Player bar: the speaker button shows a crossed-out speaker when the sound is
  muted or the volume is at zero. Point at the volume slider to see the volume
  as a percentage. It starts at 80%; 100% is full volume and there is no boost
  (discussion #8).
- Tuner: the dial glows when the mouse is over it and the wheel can turn it.
  The station cards under the dial can always scroll to the centre, including
  the first and the last station (discussion #8).
- Favorites and My Playlists: the media type is a row of buttons (**All**,
  **Radio**, **TV**, **Audio**, **Video**) instead of a drop-down
  (discussion #8).
- Favorites: sort by **My order** or **A-Z**. In My order, each card has buttons
  to move it up, move it down, or move it to the top. The Tuner follows the
  same order (discussion #8).
- Favorites: make your own categories, for example "Rock" or "Talk". Put a
  favorite in one with the tag button on its card, show one category with the
  category buttons above the list, and rename or delete a category (its
  favorites are kept). The Tuner's Source list offers each category
  (discussion #8).
- My Playlists: **Star all** adds all the channels that are listed (for the
  chosen playlist, media type and search) to Favorites (discussion #8).
- Playlist import also accepts `.pls` and `.xspf` files, besides `.m3u` and
  `.m3u8`. This works with the file picker, with drag and drop, and with an
  online link (discussion #8).
- Song title: a radio station that sends the title of its current song shows
  it under the station name in the player bar, with a note sign, and in the
  Windows media overlay. Not every station sends titles. Stations that are
  delivered as HLS do not show one, and some stations send jingles or filler
  text instead of a song (discussion #8).
- Song log: the note button at the top right opens a list of the songs you
  heard, with time, station and title. **Copy** puts a title on the clipboard,
  **Remove** takes a song off the list, **Save to file** writes a CSV file into
  the downloads folder, and **Clear log** empties the list (discussion #8).
- Stream quality: Radio Browser stations show their format and bitrate, for
  example "MP3 · 128 kbps", in the detail panel. **Other streams** lists other
  listings of the same station to pick from by hand. Nothing switches
  automatically (discussion #8).
- Station images: **Settings → Station images → Open folder** opens a
  `station-images` folder inside the data folder, so it travels with the
  portable folder. A picture named exactly like a station (PNG, JPG, WebP or
  GIF, up to 2 MB) replaces that station's artwork after **Refresh**.
  Characters Windows does not allow in file names are left out when names are
  compared (discussion #8).
- Backup: **Settings → Storage → Back up my data** writes one ZIP into the
  downloads folder. It holds favorites, settings, equalizer curves, categories,
  the song log, imported playlists and station images, plus `.m3u8` playlist
  files that other players can open (favorites for radio, TV and other media,
  and one file for each imported playlist). There is no restore button: to
  restore, close the app and copy the `WorldMediaWindows-data` folder from the
  ZIP back. Playlist addresses can contain private links or account tokens, so
  share the ZIP only with people you trust (discussion #8).
- Live radio and TV now reconnect by themselves after a dropped connection. The
  player bar says "Connection lost. Retrying..." and tries again for up to ten
  minutes. A radio stream that silently freezes is noticed after about 20
  seconds and restarted.
- Library of Congress was removed as a source: its website now refuses requests
  from apps like this one. The app has ten sources. Library of Congress
  favorites stay in the list and say "Source no longer available." when they
  cannot play.
- Library: a search with no results no longer leaves a blank loading area.
  Choosing one source right after opening no longer restarts loading for every
  source. **Retry now** and the explicit-content switch no longer leave a
  source stuck.
- The status texts in the player bar fit in a small window, and "Checking..." no
  longer stays forever after a failed Play.
- Internal: relays left behind by a rejected download or recording start, or by
  a page reload, are now released.
- Internal: the new data is stored in separate files
  (`state/profile-preferences-extra.json`, `state/song-log.json` and the
  `station-images` folder), so that going back to v0.1.8 keeps your favorites
  and settings.

## 0.1.8 - 2026-11-10

- Tuner: with only one station on the dial, the dial stays put. Arrow keys,
  the mouse wheel and dragging no longer turn it or restart the station
  (issue #6). An arrow key still starts the station when nothing is playing.
- Tuner: the knob now rests at the same angle for the same station, so the
  first station is always at the top. Going round a list, or letting go of a
  drag between two stations, used to leave the marker at an arbitrary angle.
- Tuner: clicking or releasing the dial on the station that is already playing
  no longer restarts it.
- Tuner: the dial shrinks to fit a short window instead of being cut off at
  the top and bottom, and the station name stays inside the knob. The small
  dot behind the station number is gone.
- Playlist import wording: the drop hint now names both accepted file types
  (`.m3u` and `.m3u8`), and the button is **Import playlist**.
- The player bar shows the item's initials when it has no artwork, the same as
  the cards.
- Settings: the Local port box matches the other controls.

## 0.1.7 - 2026-11-10

- Dropping a local `.m3u`/`.m3u8` file on the window imports it into My
  Playlists, the same as **Import M3U**, instead of Windows opening the file in
  Notepad (issue #5). Dropped on the Tuner, new channels default to the band the
  dial is on. Other dropped files are ignored with a short message.
- Radio and audio items whose stream has no picture (audio-only HLS or DASH)
  no longer open an empty video square. TV and video items are unchanged.
- Tuner: the station strip under the dial now keeps the current station in
  view, centred where possible, instead of letting it scroll out of sight.
- Library sidebar: the "By archive" heading is hidden when every source is
  switched off.

## 0.1.6 - 2026-11-10

- Sources switched off in Settings are left out of the Library sidebar instead
  of staying in the list greyed out (issue #4).
- Tuner: the mouse wheel now turns the dial, one station per notch; the station
  is tuned when the wheel comes to rest.
- Tuner: dragging the dial across the 9 o'clock position no longer jumps 30
  stations.
- The floating video grows with the window (320 px wide on a 1080p-wide window,
  up to 640 px at 4K), and a button in its corner switches to a larger size;
  the choice is remembered.
- Fixed the managed FFmpeg install in Settings. The provider's GitHub project
  moved from `BtbN/FFmpeg-Builds` to `FFmpeg-Builds/FFmpeg-Builds`, and the app
  refused the new address ("GitHub release repository identity is invalid").
  Existing FFmpeg installs were not affected.

## 0.1.5 - 2026-11-08

- Fixed the portable ZIP not opening a window (issue #3). The ZIP was missing
  two window-component runtime folders that pywebview checks for at startup.
  The app's own bundled .NET DLLs are also now unblocked when they were
  extracted from a downloaded zip, which Windows otherwise refused to load.
  Affected the portable ZIP since 0.1.2; the single EXE was not affected.
- A portable startup failure now exits cleanly and is written to
  `logs\native.log`, instead of leaving a hidden process running.

## 0.1.4 - 2026-11-08

- Library opens on Favorites when you have saved items (the full catalog still
  loads in the background for All Sources).
- Tuner: new "★ My favorites" choice in the Source menu puts only your starred
  stations on the dial; the choice is remembered.
- Favorites and My Playlists use compact cards, so about three times as many
  saved items fit on screen.
- Tuner marks your starred stations with ★ in the station strip and on the dial.
- Simpler cards and sidebar by default: source status labels (Pull/Wait/Done/
  Live/Stale), boxed source badges, and license notes are hidden; a source that
  needs attention shows an amber dot, and hovering a source shows its status.
  Settings → Appearance → "Show technical source details" restores the full view.
- Tuner and Grid show stations as each source answers instead of waiting for
  the slowest one, and a source that does not answer within 20 seconds is marked
  unavailable rather than holding the view on "Loading".
- More station logos appear: .ico favicons are converted to PNG, and common
  serving mistakes are repaired (images labelled as generic downloads, and
  extra bytes after the end of a PNG or JPEG). SVG logos and web pages returned
  in place of an image are still refused.
- Items without artwork show their initials on a coloured square instead of a
  grey icon, so saved lists are easier to scan.
- Tuner shows the station's place in the list ("12 of 80") instead of a made-up
  FM frequency that changed whenever the list reloaded.
- Tuner dial text is readable in the light theme.
- The window title bar now starts in the app's saved theme and repaints right
  away on Windows 10, instead of showing white until focus changed; Windows
  "settings changed" broadcasts no longer reset it to the Windows app theme.
- The Shutdown button is a quiet outline that turns red on hover, instead of a
  bright red button.
- Short HLS clips that are fully buffered start at once instead of waiting up to
  30 seconds for a six-second playback cushion they can never build.
- Update Vite to 8.3.6 (development server advisory); npm audit reports no
  vulnerabilities.
- Repository cleanup: remove completed planning/research logs, duplicate
  screenshots, one-off phase probes, and small unused code; refresh the user
  guide, file tree, and acceptance-harness instructions.

## 0.1.3 - 2026-10-07

- Keep the playlist toolbar and Add link form usable in narrow windows.
- Update vulnerable transitive build dependencies; npm audit reports no vulnerabilities.
- Keep the previous Favorites list and star state if saving fails; display an
  accessible warning for failed Favorites/settings saves and native profile backups.

- Add a friendly Add link form for named direct TV/radio streams or online M3U
  playlists, including safe remote fetching and relative stream/logo URLs.
- Acknowledge shutdown before background cleanup and exit; prevent a UI cleanup
  error from displaying Retry after the server already accepted the request.

- Add local M3U/M3U8 live-channel imports in Library's My Playlists, with portable
  native storage, playlist selection, safe artwork/playback, deduplication, and
  explicit replacement/removal that preserves favorites.
- Add local Favorites search and All/Radio/TV/Video/Audio filters.
- Reject incomplete/oversized port-change profile snapshots instead of silently
  dropping saved values; roll back partial restores and allow escaped JSON backups.
- Add an image-load watchdog so stalled artwork cannot hold a queue slot forever.
- Always schedule exit after an authenticated shutdown, even if the client
  disconnects during the response.
- Show zero counts explicitly instead of blank sidebar counts.

## 0.1.2

- Add five no-key sources: media.ccc.de/C3VOC, Library of Congress, gPodder
  podcasts, PeerTube/SepiaSearch, and Owncast, bringing the registry to eleven.
- Add an eleven-source concurrent catalog scheduler, per-provider rate limits,
  retry/cooldown handling, continuous cursor discovery, live-snapshot refresh, and
  truthful stale/rate-limited/complete status without false zero completion.
- Add authenticated semantic catalog routes for podcast feeds, PeerTube origin
  resolution, and Owncast rating-verified snapshots, plus a bounded persistent
  catalog cache and opaque artwork relay.
- Add an explicit/NSFW preference that is off by default, labels opted-in
  content, filters every mode, and preserves hidden favorites without weakening
  the network trust boundary.
- Add keyboard state, focus visibility, forced-colors support, and reduced-motion
  support while retaining a bounded 300-card DOM.
- Add seven immediate, persistent appearance choices and synchronize the
  native Windows title bar with the selected light, dark, or color theme.
- Add finite downloads, live MP3/MP4 recording, managed FFmpeg, automatic EQ,
  and global/favorite-specific presets to the persistent player bar.
- Add secure non-DRM DASH playback using bundled dash.js and an opaque,
  allow-listed SegmentTemplate relay; reject DRM and unsafe external MPD URLs.
- Make shutdown deterministic during startup and stale localhost sessions.
- Flush any EQ slider or preset-name edit still inside its debounce window
  before Shutdown or page hide so the automatic Global/favorite save cannot be
  lost during an immediate exit.
- Require every recording, download, FFmpeg-install, and job owner to confirm
  cleanup before shutdown is accepted.
- Pin the legacy metadata proxy to validated DNS addresses and enforce
  same-origin, query, redirect, and request-body limits.
- Add complete capture/storage guidance, Windows 10 22H2 provider requirements,
  reproducible build pins, and packaged third-party notices.
- Replace the antivirus-prone generated PyInstaller launcher with the official
  signed CPython 3.13.14 embedded runtime in a portable release folder/ZIP.
- Restore the owner-preferred classic `dist\WorldMediaWindows.exe` as a
  reproducible, current PyInstaller one-file build while retaining the signed
  portable folder/ZIP as an antivirus-friendly fallback.
- Keep transient source failures retryable instead of treating them as end-of-catalog.
- Give every provider a stable, cursor-based browse session with correct pagination.
- Continue automatic Internet Archive browsing across every curated collection;
  finishing a small collection such as the 81-item Classic Cartoons bucket no
  longer marks the entire Archive provider complete.
- Align proxy/client timeouts, recover failed IPTV preloads, and reduce disconnect log noise.
- Add visible Retry/Check Again controls, restore Library filters, and honor source settings live.
- Replace the rapidly wrapping per-source status pills with one fixed-height
  collection summary and compact, fixed-width Pull/Wait/Done/Live states in
  the source sidebar so catalog updates never move the gallery.
- Restore the original complete per-session Library pool so collection can grow
  past 40,000 items and finished-source counts never disappear.
- Recover transient fatal HLS media/network errors with bounded retries, cap
  IPTV adaptation to the video window, and preserve terminal Try Next behavior.
- Make legacy IPTV favorites immediately expose video recording instead of
  remaining on Checking, and keep FFmpeg capability checks single-flight.
- Select one quality-appropriate HLS rendition before recording instead of
  probing every master-playlist variant; retain cancellable bounded startup.
- Resume suspended Web Audio processing when delayed IPTV playback actually
  begins so EQ is not falsely reported unavailable after long buffering.
- Keep the EQ available when a live video has silent, delayed, or changing HLS
  audio segments; signal sampling is no longer treated as an engine failure.
- Detect HLS playback that stops advancing without a fatal error and perform a
  bounded reconnect, while cancelling recovery immediately when playback moves.
- Add a deeper live buffer and conservative bitrate headroom for irregular IPTV
  channels, and lower Windows recording-process priority to protect playback.
- Give every recording a readable local date/time suffix plus collision-safe
  numbering instead of adding a timestamp only after a name collision.
- Make Discovery query providers concurrently with a bounded deadline and strict filters.
- Add deterministic discovery regression tests and continuous integration.
- Fetch LibriVox cover art with catalog pages instead of per-card RSS requests.
- Queue, prioritize, retry, and clean up fallback thumbnail hydration; retry failed image loads.
- Remove large-session hot loops from Library filtering, IPTV paging, artwork
  registration, cache pruning, and HLS/DASH relay expiry; continuous pages now
  do work proportional to the new page rather than the whole collected catalog.
- Hydrate 24 visible thumbnails eagerly, prefetch 1,800 px ahead through 12
  bounded lanes, and release any artwork task that exceeds its 25-second
  watchdog so one failed host cannot clog thumbnail loading.
- Add a 60-second final catalog-task watchdog, a 128-request localhost backlog,
  higher bounded localhost/artwork throughput, batched disposable-cache writes,
  and change-only collection status rendering.
- Preserve the personalized portable data tree byte-for-byte while refreshing
  only its test EXE with the performance-unblocked build.

## 0.1.1

- Persist WebView2 storage so favorites, settings, and volume survive app restarts.
- Keep the Library background browse chain running while a search term is active.
- Prevent search pagination from exhausting the general browse stream.

## 0.1.0

- Created Windows-native World Media repo.
- Replaced Linux-in-a-box runtime with a local Python server and WebView2 shell.
- Added PyInstaller single-exe build path.
