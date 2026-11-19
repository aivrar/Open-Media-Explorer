# Open Media Explorer v0.1.11

A new Visualizer tab, fixes for a bug report, and more of the requests from the
discussion.

- **Visualizer:** a new tab between **Discovery** and **About** shows pictures
  that move with the sound of whatever is playing. It is ported from Psychedelia
  Studio, the author's own project. It has 71 scenes, from flat patterns to 3D
  scenes you fly through. A badge on each scene says how hard it works the
  graphics card: **Light**, **Medium** or **Heavy**. A scene with ready-made
  colour schemes has a **Look** choice. Work on the visualizer continues, and
  more is planned.
- **Visualizer shuffle:** changes the scene every 8, 16 or 32 bars of the music.
  Choose how heavy the scenes may be (**Light only**, **Light and medium** or
  **All, heavy too**), and shuffle all scenes or only your favourites.
- **Effects and overlays:** 38 post effects and 25 overlays can go over the
  picture. Both are off by default. Pick them by hand or let a shuffle pick them,
  and set the effects' strength to Subtle, Normal or Strong. One overlay can be
  blended in: with a blend mode, under the effects, in the bright or the dark
  areas of the scene, in the scene's colours, or bending the scene.
- **Visualizer favourites:** the star keeps the scene, its look, the effects and
  the overlays. The scene list has a **Favourites** filter. These are separate
  from your station favorites.
- **Visualizer picture:** **Quality** (Low, Medium or High), **Frame rate** (15,
  30 or 60) and **Brightness** (30% to 100%). **Show measured fps** shows the
  frame rate it really gets.
- **Weak computers:** when the computer cannot keep up with a scene, the
  Visualizer lowers the load by itself: effects first, then overlays, then
  quality, then frame rate. A note says what changed, and your choices stay as
  they were. For a light load, use Low quality, 15 or 30 frames a second,
  **Light only** scenes, and few or no effects and overlays.
- **Costs and sound:** the Visualizer costs nothing while its tab is closed, and
  it never changes the sound.
- **Credits:** the shader code the Visualizer borrows from others is credited
  under **Visualizer credits** on the About page, in `CREDITS.md` and in the
  packaged third-party notices.
- **Playlist import:** **Add as** now starts on **Auto**. It works out radio or
  TV by itself, from what most channels in the same file say. When some
  channels needed a type from **Add as**, the import result says how many and
  what Auto chose. Importing the same playlist again as **Radio** moves its TV
  favorites over, keeping their place, category and equalizer. The result also
  says how many entries were skipped because they point at this computer or a
  private network, and why. Two entries that have the same address but
  different names are both kept.
- **My Playlists:** a first read of the playlists that failed is tried again
  when you open My Playlists. Channels from your own playlists no longer show
  "See provider terms".
- **Tuner:** when some of your favorites are saved as the other type (TV or
  radio), the status line says so, for example "3 more saved as TV (switch to TV
  to see them)", instead of the stations silently missing from the dial.
- **Player bar:** the bar no longer jumps sideways on every station change.
- **Station pictures:** a station whose name has a character a file name cannot
  have, such as the "/" in "Nu-Metal/Alternative", now matches a picture that
  uses `-`, `_`, a space or nothing in its place. The rule is shown in
  **Settings > Station images**, which also lists the pictures that were not
  used at the last scan and why.
- **Favorites:** cards in My order have a **Move to bottom** button, and
  **Remove all favorites** asks first, with the number of favorites and a hint
  to back up your data. The playlist and favorites controls now say how to
  remove and change stations.
- **Small fixes:** four-letter initials on Medium and Large Tuner cards are no
  longer cut off, the seek and volume slider tracks are now visible in the Light
  theme, the status line under the player bar no longer cuts the tails of
  letters, and the "0 dB" label in the EQ graph sits above the line.
- **Local port (Windows):** a second copy of World Media can no longer share the
  first copy's local port. If the usual port is busy and answers as World Media,
  the new copy waits up to 8 seconds before it tries another port. This covers
  a copy that was just closed and one that is still running.

Please note: the Visualizer shows moving, flashing pictures. A notice about
flashing lights and photosensitivity comes before the first picture, and a flash
limiter is always on, but it cannot rule out every risk. If you, or anyone
watching, may be sensitive to flashing lights or patterns, please use
discretion.

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6) and the
requests in
[discussion #8](https://github.com/aivrar/Open-Media-Explorer/discussions/8).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.11-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.10
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
