# Visualizer

The Visualizer tab requires v0.1.11 or newer.

The Visualizer shows pictures that move with the sound of whatever is playing.
It is the tab between **Discovery** and **About**. It is ported from [Psychedelia
Studio](https://github.com/aivrar/psychedelia-studio), the author's own project.
Work on the Visualizer continues, and more is planned, so this page describes
this version.

## Please read first: moving and flashing pictures

The Visualizer shows moving, pulsing and colour-changing patterns that follow
the music. If you, or anyone watching, may be sensitive to flashing lights or
patterns (photosensitive epilepsy), please use discretion.

- The first time you open the tab, a notice called **Before the picture moves**
  comes first. Nothing is loaded and nothing moves until you press
  **Continue**. **Not now** leaves the picture still, with a **Start the
  visualizer** button.
- You can read the notice again at any time with **About flashing and
  photosensitivity**, at the bottom of the settings panel. The picture behind it
  pauses while it is open.
- A flash limiter is always on. It keeps light pulses to at most three a second
  and fades between scenes. It cannot rule out every risk. There is no switch
  to turn it off.

## Open the Visualizer

1. Start something playing, for example a radio station.
2. Open the **Visualizer** tab. Accept the notice the first time.
3. The picture moves with the sound. Use the buttons over the picture, or the
   settings button, to change it.

While nothing can be heard (playback is paused or stopped, the sound is muted,
or the volume is at zero), the picture keeps moving slowly for about 20
seconds, then holds still. Nothing is drawn after that until sound comes back.
It also stays still when Windows is set to show fewer animations, and nothing
is drawn while the window is minimised or hidden.

The Visualizer reads the sound in the same way as the sound meter in the player
bar (see [Playback, EQ, downloads, and
recording](04-playback-eq-downloads-recording.md)). It only listens: it never
changes what you hear, what the EQ does, or what is recorded. If the meter is
flat while you can hear the station, the picture has no sound to follow either.

## The buttons over the picture

A few small buttons sit over the picture. They fade away after about three
seconds without mouse movement and come back when you move the mouse, touch the
screen or press any key.

| Button | What it does |
|---|---|
| **Previous scene** and **Next scene** | Move through the scene list in its order. With the shuffle on, they walk back through the scenes it showed (up to 50) and forward to a new pick. |
| **Shuffle scenes** | Turns the scene shuffle on or off. |
| **Add to favourites** (a star) | Keeps what you see now. Press it again to remove it. See **Favourites** below. |
| **Visualizer settings** (three lines) | Opens or closes the settings panel. **Escape** closes it. |

Scenes fade into each other. They never cut hard, except when Windows is set
to show fewer animations.

## The settings panel

The panel opens on the right. It remembers whether it was open. It has these
sections, from the top.

### Scene

The scene button shows the scene's name and badge. Press it to open the list.

- There are 71 scenes, grouped by category: Color, Cosmic, Demoscene,
  Distortion, Endless Scenes, Fractals, Geometry, Math, Nature, Noise,
  Patterns, Psychedelic and Retro. Some are flat patterns, such as Plasma,
  Tunnel and Starfield. Others are 3D scenes you fly through, such as
  Mandelbulb Flight, Menger Citadel and Planet Sunrise.
- Each scene has a badge that says how hard it works the graphics card.
  **Light** (26 scenes) needs little. **Medium** (21 scenes) works it
  moderately. **Heavy** (24 scenes) is hard on it, and its quality may be
  lowered on a weaker computer.
- Type in the **Search scenes** box to filter by name, category or badge word.
  Press **Up** or **Down** to move through the list, **Enter** to pick, and
  **Escape** to close it.
- **Favourites** at the top of the list shows only the scenes you starred.

**Look:** a scene with ready-made colour schemes shows **Look** with two arrows.
Press them to step through the looks. Your choice is remembered for each scene.
A scene without looks does not show it.

### Shuffle

- **Shuffle:** **Off**, **All scenes** or **Favourites only**. The same switch
  is the shuffle button over the picture.
- **Scenes:** how heavy the shuffled scenes may be. **Light only**, **Light and
  medium** (the default) or **All, heavy too**.
- **Change every:** **8 bars**, **16 bars** (the default) or **32 bars** of the
  music. The change comes on a bar line when the Visualizer is sure of the
  tempo. A change comes no sooner than 20 seconds and no later than two minutes
  after the last one.

The shuffle shows every scene once before it shows one again, avoids the same
category three times in a row, and leans towards calm scenes for calm music and
lively scenes for lively music. The line **Music** under it says what the
Visualizer hears: calm, steady or energetic. It prepares the next scene ahead
so the change is quick, and it changes only when the flash limiter has room.

If **Favourites only** has nothing to show, a line says why: "No favourites yet.
Star a scene to use this." or "None of your favourites is in the Scenes choice
below."

### Effects

Post effects change the whole picture: mirror, swirl, glitch, bloom, CRT and so
on. They are off by default.

- **Effects on:** the master switch. The effects' library is loaded the first
  time you turn it on.
- **Shuffle effects:** on by default. The Visualizer picks the effects.
  **New effects now** picks a new set at once.
- **Change effects:** **With the scene** (the default), or **Every 4, 8 or 16
  bars**.
- **Strength:** **Subtle**, **Normal** (the default) or **Strong**. It sets how
  much the effects change the picture.
- **Beat flash (limited):** off by default. A short brightening on kick and
  snare hits, kept inside the flash limiter.
- **The list:** 38 effects in six groups: Distort (9), Feedback (4), Colour (4),
  Stylize (10), Glow & Blur (3) and Lens & Retro (8). With **Shuffle effects**
  off, tick the ones you want. Point at an effect to see its group and how
  heavy it is.

At most three effects work at once, and two when **Quality** is Low. Some
scenes are easily pushed into flicker by effects. For those scenes, the
shuffle keeps to the calmer effects, at most two, and the panel greys out the
others with the note "Greyed effects are not shown with this scene: it would
flicker."

### Overlays

Overlays are drawn over the picture: lasers, stage lights, fireworks,
particles, matrix rain, spectrum bars, shapes and more. The section is folded
until you open it with its title. It opens by itself when overlays are on.

- **Overlays on**, **Shuffle overlays** (on by default) and **New overlays
  now** work like the effects' switches.
- **The list:** 25 overlays. Up to three work at once, and two when **Quality**
  is Low. Lightning is only used when you tick it by hand. Point at an overlay
  to see its group and how heavy it is.
- **Blend-ins:** one chosen overlay at a time can be blended into the picture
  instead of just lying on top. Each chosen overlay has a row of choices:
  - **Blend:** Add (plain, on top), Screen, Multiply, Soft light or Difference.
  - **Show:** **Everywhere**, **In bright areas** or **In dark areas** of the
    scene.
  - **Under the effects:** the overlay goes under the effects, so they change
    it too.
  - **Scene colours:** the overlay takes the scene's colours.
  - **Bend the scene:** the overlay's light moves the scene's picture a little.

A few scenes cannot take every blend without flickering. The panel then says
"Greyed blends are not used with this scene: they would flicker."

### Picture

- **Quality:** **Low**, **Medium** (the default) or **High**. It sets how sharp
  the picture is. Low draws it with half as many pixels across and down as the
  tab has, Medium with three quarters, and High with all of them (with a limit
  on very big screens). The picture is stretched to fill the tab at every
  quality.
- **Frame rate:** **15**, **30** (the default) or **60** pictures a second while
  sound plays.
- **Brightness:** from 30% to 100%, in steps of 5. It dims the whole picture and
  costs nothing.
- **Show measured fps:** shows the frame rate the Visualizer really gets, at the
  top left of the picture. It is off by default.

## Favourites

The Visualizer's favourites are not your station favorites. They are kept
separately, and they keep the way the picture looks, not a station.

- Press the star over the picture to keep the scene you see, with its look and
  the effects and overlays chosen for it. That includes any the automatic
  step-down is holding back for the moment. Effects that the scene leaves out
  because they would flicker are not kept. The star is filled when that exact
  combination is kept. Press it again to remove it. Up to 128 are kept.
- In the scene list, **Favourites** shows only the starred scenes. Picking one
  brings back what was starred with it. Picking the same scene again steps
  through its other favourites.
- With **Shuffle** on **Favourites only**, the shuffle goes through your
  favourites, with the look, effects and overlays each one keeps.

## Keep it light on a weak computer

The Visualizer costs nothing while its tab is closed. Leaving the tab stops
every timer and frame, drops the sound subscription and gives the graphics back.
While the tab is open, these choices make it lighter:

- Set **Quality** to Low.
- Set **Frame rate** to 15 or 30.
- Choose **Light** scenes. With the shuffle, set **Scenes** to **Light only**.
- Keep effects and overlays off, or tick only one or two. They are off by
  default.
- Use **Show measured fps** to see what you really get.

Brightness does not change the load.

## The automatic step-down

When the computer cannot keep up with a scene, the Visualizer lowers the load
for that scene by itself. It measures how often it can draw a picture. When the
pictures come in at less than about 80% of the chosen frame rate (or of what
the display can show, if that is lower) for a few seconds, twice in a row, it
takes one step. A short hitch does not count.

The steps come in this order:

1. Fewer effects, down to one, then none.
2. Fewer overlays, down to one, then none.
3. Lower quality: High, then Medium, then Low.
4. At Low, a lower frame rate: 60, then 30, then 15.

A note at the bottom right says what changed: "Fewer effects to keep this scene
smooth", "Fewer overlays to keep this scene smooth", "Fewer effects and overlays
to keep this scene smooth" or "Lowered quality to keep this scene smooth".

Your choices stay as they were. Effects and overlays that were held back stay
ticked, and the saved quality and frame rate do not change. The next scene
starts with all your effects and overlays and at the quality you chose again,
unless it needed less earlier in the same visit. In that case it starts at what
it needed, so a heavy scene does not slow down again each time. A scene never
steps back up by itself. After the quality or the frame rate was lowered, the
shuffle also keeps to scenes one class lighter than the one that needed it.

Choosing a **Quality** or a **Frame rate** by hand clears the step-down, and so
does closing the tab.

## Notes and messages

- **Preparing scene...** shows at the bottom right when a scene takes a moment
  to load. The scene before it keeps moving.
- "The visualizer needs WebGL graphics, which are not available on this computer
  right now." means the graphics could not be started. See
  [Troubleshooting](06-troubleshooting.md).
- "The graphics driver was reset. The picture comes back by itself when it is
  ready." shows after a graphics driver reset.
- "Windows is set to reduce animations, so the picture stays still." shows when
  Windows is set to show fewer animations.
- With **Show measured fps** on, the top left corner reads a number such as
  "30 fps", or "Still picture, no sound playing" or "Not drawing, window not in
  view".

## Where its choices are saved

The Visualizer's choices (scene, looks, shuffle, effects, overlays, quality,
frame rate, brightness, favourites and whether you accepted the notice) are
stored inside your settings in the browser profile. They are not a separate
file. **Clear local cache** resets them with the rest of your settings, so the
notice comes back too. See [Data, cache, and
portability](05-data-cache-and-portability.md).

## Credits

Some of the shader code in the scenes is borrowed from others and keeps its own
licence. It is credited under **Visualizer credits** on the About page (open
**Borrowed shader code** to read each piece), in
[CREDITS.md](../../CREDITS.md) and in the packaged third-party notices at
`/THIRD_PARTY_NOTICES.txt`.
