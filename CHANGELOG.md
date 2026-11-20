# Changelog

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
