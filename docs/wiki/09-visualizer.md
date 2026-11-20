# Visualizer

The Visualizer tab requires v0.1.11 or newer. The scene families listed under
**Scene** below, the extra looks of the labs, **Palette Map**, **Strobe**,
**Slow drift**, **Very high** quality and the folding sections of the settings
panel require v0.1.12 or newer.

The Visualizer shows pictures that move with the sound of whatever is playing.
It is the tab between **Discovery** and **About**. It is ported from [Psychedelia
Studio](https://github.com/aivrar/psychedelia-studio), the author's own project.
Work on the Visualizer continues, and more is planned, so this page describes
this version.

## Please read first: moving and flashing pictures

The Visualizer shows moving, pulsing and color-changing patterns that follow
the music. If you, or anyone watching, may be sensitive to flashing lights or
patterns (photosensitive epilepsy), please use discretion.

- The first time you open the tab, a notice called **Before the picture moves**
  comes first. Nothing is loaded and nothing moves until you press
  **Continue**. **Not now** leaves the picture still, with a **Start the
  Visualizer** button.
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
is drawn while the window is minimized or hidden.

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
| **Add to favorites** (a star) | Keeps what you see now. Press it again to remove it. See **Favorites** below. |
| **Visualizer settings** (three lines) | Opens or closes the settings panel. **Escape** closes it. |

Scenes fade into each other. They never cut hard, except when Windows is set
to show fewer animations.

## The settings panel

The panel opens on the right. It remembers whether it was open. It has five
sections, from the top: **Scene**, **Shuffle**, **Effects**, **Overlays** and
**Picture**.

Each section starts with a title bar: an arrow, the section's name and, at the
right, what is set, so a folded section still tells you its state:

| Section | Says at the right |
|---|---|
| **Scene** | nothing (the scene button below shows the scene) |
| **Shuffle** | **Off**, **All scenes** or **Favorites only** |
| **Effects** | **On** or **Off** |
| **Overlays** | **On** or **Off** |
| **Picture** | the quality and frame rate, for example **Medium, 30 fps** |

Click a title bar, or press Enter or Space on it, to fold the section or open
it again. Every section is open at first, and the sections you fold stay
folded the next time. In **Effects** and **Overlays**, the **Effects on** and
**Overlays on** switches are always shown; their other controls show only
while the switch is on.

### Scene

The scene button shows the scene's name and badge. Press it to open the list.

- There are 99 scenes, grouped by category: Color, Cosmic, Demoscene,
  Distortion, Endless Scenes, Fractals, Geometry, Math, Nature, Noise,
  Patterns, Psychedelic, Retro, Simulation and Sound Shapes. Some are flat
  patterns, such as Plasma, Tunnel and Starfield. Others are 3D scenes you fly
  through, such as Mandelbulb Flight, Menger Citadel and Planet Sunrise.
- Each scene has a badge that says how hard it works the graphics card.
  **Light** (32 scenes) needs little. **Medium** (23 scenes) works it
  moderately. **Heavy** (44 scenes) is hard on it, and its quality may be
  lowered on a weaker computer.
- Type in the **Search scenes** box to filter by name, category or badge word.
  Press **Up** or **Down** to move through the list, **Enter** to pick, and
  **Escape** to close it.
- **Favorites** at the top of the list shows only the scenes you starred.
- **Slow drift** (on by default) lets the scene change slowly by itself. See
  **Slow drift** below.

Among the scenes are these families:

- **Line drawings:** Hopf Fibration, Knots & Surfaces, Lissajous, Attractor
  Ribbons and Spirograph (in Math). Curves, knots and rings drawn as glowing
  lines.
- **Simulations:** Curl-Noise Silk, Fluid Ink, Lenia, Physarum and
  Reaction-Diffusion (in Simulation), and Feedback Loop (in Distortion).
  Pictures that grow and flow from one frame to the next, such as ink stirred
  in water, a network of glowing veins, or soft creatures that glide and
  divide.
- **Flights:** Apollonian Foam Flight, Folded Box Variants Flight, Mandelbox
  Flight, Triplex Mutation Flight and Glass Fractal DE Flight (in Fractals).
  Journeys through 3D fractal shapes.
- **Buddhabrot Lab** (in Fractals): a still picture that builds up point by
  point within about a minute, then stays as it is until you change the
  look. It takes no post effects.
- **Labs:** 2D Formula Lab, Analytic Field Lab, Procedural Field Lab and
  Fractal Flame Lab (in Fractals). Each draws moving pictures from a whole
  family of formulas. Three of them also have extra looks, one for each
  formula that none of their ready-made looks shows, 28 in all: 2D Formula Lab
  16 (such as Multibrot, Burning Ship, Phoenix, Magnet II and Nova), Analytic
  Field Lab 2 (Pentagrid Loom and Arnold Tongue Map) and Fractal Flame Lab 10
  (pairs of variations, such as Heart + Spherical and Swirl + Julia). They come
  after the others when you step through **Look**.
- Also **Cymatics** (in Math), sand gathering on the still lines of a
  vibrating plate, and **Robot Foundry** (in Endless Scenes), a flight past a
  procession of dancing robots.
- **World Media's own scenes:** Band Ridgelines, Sound Ring and Petal Bloom
  (in Sound Shapes), and Hex Weave and Contour Lines (in Patterns), written
  for this app. The music moves only their shapes, never their colors or
  brightness. Each has four looks.

The line drawings, simulations, flights, Buddhabrot Lab, Fractal Flame Lab,
2D Formula Lab and Robot Foundry are all **Heavy**. Some scenes need graphics
features that not every computer has, such as the simulations; where they are
missing, those scenes are not in the list.

Names that come from the copied code are shown in American spelling, for
example **Complex Domain Coloring** and the **Watercolor** effect.

**Look:** a scene with ready-made color schemes shows **Look** with two arrows.
Press them to step through the looks. Your choice is remembered for each scene.
A scene without looks does not show it.

### Shuffle

- **Shuffle:** **Off**, **All scenes** or **Favorites only**. The same switch
  is the shuffle button over the picture.
- **Scenes:** how heavy the shuffled scenes may be. **Light only**, **Light and
  medium** (the default) or **All, heavy too**. With **Processor use** set to
  **Balanced** or **High** (in Settings), the default **Light and medium**
  takes heavy scenes too, and a line under it says so: "Processor use is set to
  Balanced: heavy scenes are included too." A choice you make here by hand is
  always kept as it is, at every Processor use level.
- **Change every:** **8 bars**, **16 bars** (the default) or **32 bars** of the
  music. The change comes on a bar line when the Visualizer is sure of the
  tempo. A change comes no sooner than 20 seconds and no later than two minutes
  after the last one.

The shuffle shows every scene once before it shows one again, avoids the same
category three times in a row, and leans toward calm scenes for calm music and
lively scenes for lively music. It prepares the next scene ahead so the change
is quick, and it changes only when the flash limiter has room.

The line **Music** under it says what the Visualizer hears: **calm**, **steady**
or **energetic**. It counts the drum hits and looks at how fast a beat it is
sure of. One drum stroke heard in several parts of the sound counts once, a
kick or a snare counts fully, and hi-hats alone count half, so busy hi-hats
over a slow beat do not make the music read as energetic. The tempo adds to
the reading only from 80 beats a minute.

- **calm:** few hits and no fast beat, or almost no sound;
- **energetic:** many hits and a quick beat, as in dance music;
- **steady:** anything in between. It starts as steady.

A new mood must last a few seconds before the line changes, and it changes at
most every ten seconds. After another station, a pause, or a gap in the sound,
the reading starts afresh, and the line keeps its last word until the new
reading is ready. A screen reader reads the line once when the panel opens, not
at every change. Besides the shuffle's leaning, the mood makes the picture's
reaction to the beat a little gentler for calm music and a little stronger for
energetic music, always inside the flash limiter. The **Strobe**
overlay is picked by the shuffle only while the music is energetic.

If **Favorites only** has nothing to show, a line says why: "No favorites yet.
Star a scene to use this." or "None of your favorites is in the Scenes choice
below."

### Effects

Post effects change the whole picture: mirror, swirl, glitch, bloom, CRT and so
on. They are off by default.

- **Effects on:** the master switch, always shown. The effects' library is
  loaded the first time you turn it on. The controls below show only while it
  is on.
- **Shuffle effects:** on by default. The Visualizer picks the effects.
  **New effects now** picks a new set at once.
- **Change effects:** **With the scene** (the default), or **Every 4, 8 or 16
  bars**.
- **Strength:** **Subtle**, **Normal** (the default) or **Strong**. It sets how
  much the effects change the picture.
- **Beat flash (limited):** off by default. A short brightening on kick and
  snare hits, kept inside the flash limiter.
- **The list:** 39 effects in six groups: Distort (9), Feedback (4), Color (5),
  Stylize (10), Glow & Blur (3) and Lens & Retro (8). With **Shuffle effects**
  off, tick the ones you want. Point at an effect to see its group and how
  heavy it is.
- **Palette Map** (in Color) recolors the whole picture with one of the color
  schemes, slowly moving through it. It is one of the livelier effects, so it
  is not shown with the scenes that take only calm effects, and it is never
  shown together with Halftone or Fisheye.

At most three effects work at once, and two when **Quality** is Low. Some
scenes are easily pushed into flicker by effects. For those scenes, the
shuffle keeps to the calmer effects, at most two, and the panel grays out the
others with the note "Grayed effects are not shown with this scene: it would
flicker." A few pairs of effects are never shown together; when you tick one of
them, the other is grayed with the note "Grayed effects are not shown together
with another one chosen: they would flicker."

### Overlays

Overlays are drawn over the picture: lasers, stage lights, fireworks,
particles, matrix rain, spectrum bars, shapes and more. They are off by
default.

- **Overlays on** (always shown), **Shuffle overlays** (on by default) and
  **New overlays now** work like the effects' switches. The controls below
  **Overlays on** show only while it is on.
- **The list:** 26 overlays in five groups: Light show (6), Shapes (6),
  Atmosphere (6), Audio (1) and Ours (7, written for World Media). Up to three
  work at once, and two when **Quality** is Low. Lightning is only used when
  you tick it by hand. Point at an overlay to see its group and how heavy it
  is.
- **Strobe** (in Light show) is a soft colored pulse on the beat, kept inside
  the flash limiter. The shuffle picks it only while the music is energetic;
  you can tick it by hand at any time. When it is chosen, its row has a
  **Style** choice: **From the center**, **From the edges**, **Sweep**,
  **Halves**, or **Any** (one is picked for you). The style you pick is kept
  with your Visualizer settings. With **Scene colors** it takes the scene's
  colors but never turns plain white.
- **Blend-ins:** one chosen overlay at a time can be blended into the picture
  instead of just lying on top. Each chosen overlay has a row of choices:
  - **Blend:** Add (plain, on top), Screen, Multiply, Soft light or Difference.
  - **Show:** **Everywhere**, **In bright areas** or **In dark areas** of the
    scene.
  - **Under the effects:** the overlay goes under the effects, so they change
    it too.
  - **Scene colors:** the overlay takes the scene's colors.
  - **Bend the scene:** the overlay's light moves the scene's picture a little.
  - **Style:** for overlays that have styles, such as Strobe.

A few scenes cannot take every blend without flickering. The panel then says
"Grayed blends are not used with this scene: they would flicker."

### Picture

- **Quality:** **Low**, **Medium** (the default) or **High**. It sets how sharp
  the picture is. Low draws it with half as many pixels across and down as the
  tab has, Medium with three quarters, and High with all of them (with a limit
  on very big screens). The picture is stretched to fill the tab at every
  quality. With **Processor use** at Balanced or High (in Settings) there is
  also **Very high**: every pixel on bigger screens too, such as 2560 x 1440
  (up to twice High's limit). On a screen up to about 1920 x 1080, High already
  draws every pixel, so Very high looks the same there. Heavy scenes still draw
  at High there, except Mandelbox Flight and the simulations Curl-Noise Silk,
  Fluid Ink, Lenia and Physarum, and a line under the choice says "This scene
  draws at High". At Low a saved Very high draws as High and is kept for when
  the level is raised again. At **High** Processor use, Curl-Noise Silk, Fluid
  Ink and Physarum also start at a larger size (more particles or a finer
  grid) when **Quality** is High or Very high.
- **Frame rate:** **15**, **30** (the default) or **60** pictures a second while
  sound plays.
- **Brightness:** from 30% to 100%, in steps of 5. It dims the whole picture and
  costs nothing.
- **Show measured fps:** shows the frame rate the Visualizer really gets, at the
  top left of the picture. It is off by default.

## Slow drift

**Slow drift** is in the Scene section and is on by default. While a scene is
shown, a few of its settings, and of the effects on it, move slowly back and
forth, in time with the bars of the music. They move further when the music
swells and less in quiet passages. Drift changes shapes, sizes and color mixes,
never brightness, and every scene shows the same drift each time it comes back.
A few scenes drift less, or not at all, because drifting would make them
flicker.

With **Slow drift** on, the overlays also move slowly: they turn a little,
breathe (grow and shrink a little) and sway, in time with the bars. Overlays
drawn along the edges of the screen or along its horizontal lines hold still,
and so do the overlays drawn on the same layer with them. Turning **Slow
drift** off stops both.

## Favorites

The Visualizer's favorites are not your station favorites. They are kept
separately, and they keep the way the picture looks, not a station.

- Press the star over the picture to keep the scene you see, with its look and
  the effects and overlays chosen for it. That includes any the automatic
  step-down is holding back for the moment. Effects that the scene leaves out
  because they would flicker are not kept. The star is filled when that exact
  combination is kept. Press it again to remove it. Up to 128 are kept.
- In the scene list, **Favorites** shows only the starred scenes. Picking one
  brings back what was starred with it. Picking the same scene again steps
  through its other favorites.
- With **Shuffle** on **Favorites only**, the shuffle goes through your
  favorites, with the look, effects and overlays each one keeps.

## Keep it light on a weak computer

The Visualizer costs nothing while its tab is closed. Leaving the tab stops
every timer and frame, drops the sound subscription and gives the graphics back.
While the tab is open, these choices make it lighter:

- Set **Quality** to Low.
- Set **Frame rate** to 15 or 30.
- Choose **Light** scenes. With the shuffle, set **Scenes** to **Light only**.
  The line drawings, simulations and flights are all Heavy.
- Keep **Processor use** (in Settings) at **Low**, the default.
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
3. Lower quality: Very high, then High, then Medium, then Low.
4. At Low, a lower frame rate: 60, then 30, then 15.

A note at the bottom right says what changed: "Fewer effects to keep this scene
smooth", "Fewer overlays to keep this scene smooth", "Fewer effects and overlays
to keep this scene smooth" or "Lowered quality to keep this scene smooth".

Your choices stay as they were. Effects and overlays that were held back stay
ticked, and the saved quality and frame rate do not change. The next scene
starts with all your effects and overlays and at the quality you chose again,
unless it needed less earlier in the same visit. In that case it starts at what
it needed, so a heavy scene does not slow down again each time. With
**Processor use** at **Low** (the default), a scene never steps back up by
itself. At **Balanced** and **High**, the Visualizer also steps down when the
app uses more of the processor than the limit you set, and steps back up
slowly when there is plenty of room; see **Processor use** in [Using the
application](02-using-the-application.md#processor-use). After the quality or the frame rate was lowered, the
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

The Visualizer's choices (scene, looks, shuffle, effects, overlays and their
styles, Slow drift, quality, frame rate, brightness, favorites, the panel's
folded sections and whether you accepted the notice) are
stored inside your settings in the browser profile. They are not a separate
file. **Clear local cache** resets them with the rest of your settings, so the
notice comes back too. See [Data, cache, and
portability](05-data-cache-and-portability.md).

## Credits

Some of the shader code in the scenes is borrowed from others and keeps its own
license. It is credited under **Visualizer credits** on the About page (open
**Borrowed shader code** to read each piece), in
[CREDITS.md](../../CREDITS.md) and in the packaged third-party notices at
`/THIRD_PARTY_NOTICES.txt`.
