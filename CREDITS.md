# Credits

World Media uses public media catalogs and streams from:

- Radio Browser — community internet-radio directory
- iptv-org — public free-to-air stream registry
- Internet Archive — on-demand archive media
- NASA Image and Video Library — official NASA media
- Wikimedia Commons — free-licensed and public-domain files
- LibriVox — public-domain audiobook recordings
- media.ccc.de / C3VOC — conference recordings and event streams
- gPodder.net and podcast publishers — directory metadata and RSS/Atom media
- PeerTube / SepiaSearch — federated public video
- Owncast Directory and independent broadcasters — self-hosted live video

Library of Congress was a source in earlier versions. It was removed because
its site no longer answers apps (it asks for a browser check instead).

Each catalog entry, stream, and file retains its provider, publisher, creator,
or broadcaster rights. World Media's MIT license applies only to the app.

Playback uses vendored hls.js 1.5.13 (Apache-2.0) and bundled dash.js 5.2.0
(BSD-3-Clause). See `public/THIRD_PARTY_NOTICES.txt` for packaged runtime notices.

The Visualizer's scenes and shader helpers come from Psychedelia Studio (MIT,
same author), copied by `scripts/import_psychedelia.mjs`. The copied files
(each unchanged except where the manifest records an import patch, listed
with its SHA-256 in `src/visualizer/vendor/psychedelia/manifest.json`):

- Engine: `src/engine/shader-manager.js`, `src/effects/registry.js`, the
  3D flight helpers `src/effects/fractal-flight-common.js`, the
  Beat Reactor `src/engine/audio-reactor.js` with `src/engine/audio-signal.js`,
  and the post effects library `src/engine/post-fx-library.js` (its shader
  passes; the app runs them in `src/visualizer/fx-chain.js`, which also holds
  a copy of the Beat Reactor pass shader from Psychedelia's
  `src/engine/post-process.js`). Its Oil Paint pass is a Kuwahara filter
  (Michiyoshi Kuwahara and colleagues, 1976) and its Retro Dither pass ordered
  (Bayer) dithering (Bryce Bayer, 1973): the published algorithms, written
  afresh. Its Palette Map pass is not included yet (Psychedelia's palettes
  are look-up textures the app does not bind yet).
- Overlays: `src/engine/overlays.js` (its Canvas 2D overlays; the app draws
  them in `src/visualizer/overlay-layer.js`). Its Strobe, Text, Lyrics and
  Image overlays are not offered. The overlays marked "ours" in
  `src/visualizer/overlay-catalog.js` (`src/visualizer/overlay-patterns.js`)
  are World Media's own.
- Scenes: `src/effects/plasma.js`, `src/effects/tunnel.js`,
  `src/effects/starfield.js`, `src/effects/metaballs.js`,
  `src/effects/voronoi.js`, `src/effects/synthwave-grid.js`,
  `src/effects/truchet-tiles.js`, `src/effects/quasicrystal.js`,
  `src/effects/islamic-stars.js`, `src/effects/spiral-galaxy.js`,
  `src/effects/domain-colouring.js`, `src/effects/aurora.js`,
  `src/effects/black-hole.js`, `src/effects/burning-ship.js`,
  `src/effects/color-cycle.js`, `src/effects/domain-warp.js`,
  `src/effects/droste.js`, `src/effects/endless-terrain.js`,
  `src/effects/fire.js`, `src/effects/flow-field.js`,
  `src/effects/fractal-brownian.js`, `src/effects/fractal-flame.js`,
  `src/effects/glow-lab.js`, `src/effects/gyroid-tunnels.js`,
  `src/effects/hyperbolic-tiling.js`, `src/effects/julia-set.js`,
  `src/effects/kaleidoscope.js`, `src/effects/kleinian.js`,
  `src/effects/liquid-chrome.js`, `src/effects/liquid-light.js`,
  `src/effects/living-sun.js`, `src/effects/lyapunov-fractal.js`,
  `src/effects/mandelbrot-deep.js`, `src/effects/mandelbrot-power.js`,
  `src/effects/mandelbrot.js`, `src/effects/mandelbulb-slice.js`,
  `src/effects/moire.js`, `src/effects/nebula.js`,
  `src/effects/newton-fractal.js`, `src/effects/nova-fractal.js`,
  `src/effects/op-art.js`, `src/effects/orbit-trap.js`,
  `src/effects/perlin-noise.js`, `src/effects/phoenix-fractal.js`,
  `src/effects/phyllotaxis.js`, `src/effects/polar-spiral.js`,
  `src/effects/rainy-window.js`, `src/effects/rotozoom.js`,
  `src/effects/seascape.js`, `src/effects/sierpinski.js`,
  `src/effects/sine-interference.js`, `src/effects/soap-bubbles.js`,
  `src/effects/swirl.js`, `src/effects/tricorn.js`,
  `src/effects/underwater.js`, `src/effects/water-ripple.js`,
  `src/effects/wave-distort.js`
- 3D flights: `src/effects/mandelbulb-flight.js`,
  `src/effects/triplex-mutation-flight.js`, `src/effects/kifs-flight.js`,
  `src/effects/difs-tunnel-flight.js`, `src/effects/mandelbox-flight.js`,
  `src/effects/folded-box-variants-flight.js`,
  `src/effects/quaternion-julia-flight.js`,
  `src/effects/hypercomplex-slice-flight.js`,
  `src/effects/schottky-inversion-flight.js`,
  `src/effects/apollonian-foam-flight.js` (parts under other licences: see
  below), `src/effects/polyfold-flight.js`,
  `src/effects/fractal-flame-volume-flight.js`,
  `src/effects/strange-attractor-flight.js`,
  `src/effects/lsystem-tube-flight.js`,
  `src/effects/path-traced-fractal-flight.js` (Glass Fractal DE Flight)
- Endless scenes: `src/effects/endless-scenes.js` (Menger Citadel, Recursive
  Cathedral, Fractal Canyon, Infinite Lattice) and
  `src/effects/endless-sky-crystal.js` (Crystal Geode, Golden-Hour Clouds,
  Planet Sunrise)

### Borrowed code inside those files

The app is free and makes no money, so borrowed shader code is used with
credit. One entry per piece, as Psychedelia credits it (its
THIRD_PARTY_NOTICES.md), with the licence as the source states it. The same
list, per scene, is in `src/visualizer/vendor/psychedelia/manifest.json`
(`borrowed`), with flags for non-commercial and no-licence-stated pieces.

- **3D simplex noise** (`snoise` and helpers, the base of the shared `fbm`,
  in `src/engine/shader-manager.js`). Scenes: every scene (shader prelude).
  Author: Ian McEwan, Ashima Arts, with Stefan Gustavson. Source:
  https://github.com/ashima/webgl-noise/blob/master/src/noise3D.glsl.
  Licence: MIT ("Copyright (C) 2011 Ashima Arts. All rights reserved.
  Distributed under the MIT License."; text in
  `src/visualizer/vendor/psychedelia/webgl-noise-LICENSE.txt`).
- **RGB to HSV and HSV to RGB** (`rgb2hsv`, `hsv2rgb`, `toHsv` in
  `src/engine/shader-manager.js` and `src/engine/post-fx-library.js`).
  Scenes: every scene, and the post effects. Author: Sam Hocevar. Source:
  https://stackoverflow.com/a/17897228. Licence: WTFPL.
- **Cosine palette** `palette()` (`src/engine/shader-manager.js`). Scenes:
  every scene. Author: Inigo Quilez. Source:
  https://iquilezles.org/articles/palettes/. Licence: MIT for code snippets
  ("all technical code snippets you'll find are under the MIT license",
  https://iquilezles.org/articles/).
- **ACES filmic tone-mapping curve fit** (`psyTonemap` in
  `src/engine/shader-manager.js`). Scenes: every scene.
  Author: Krzysztof Narkowicz. Source:
  https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/.
  Licence: "free to use under public domain CC0 or MIT license".
- **Hash without Sine**, with adjusted constants. Scenes: Endless Terrain,
  Living Sun, Nebula Flythrough, Menger Citadel, Recursive Cathedral,
  Fractal Canyon, Infinite Lattice, Crystal Geode, Golden-Hour Clouds,
  Planet Sunrise. Author: David Hoskins. Source:
  https://www.shadertoy.com/view/4djSRW. Licence: MIT License, Copyright
  (c)2014 David Hoskins.
- **Distance functions** `sdBox`, `sdTorus`, `sdOctahedron` (bound version)
  and the 2D box. Scenes: Sierpinski, Apollonian Foam Flight, DIFS Tunnel
  Flight, Folded Box Variants Flight, KIFS Fold Flight, Mandelbox Flight,
  Glass Fractal DE Flight, Polyfold Flight. Author: Inigo Quilez. Source:
  https://iquilezles.org/articles/distfunctions/. Licence: MIT for code
  snippets (as above).
- **Polynomial smooth minimum** `smin`. Scene: Liquid Chrome. Author: Inigo
  Quilez. Source: https://iquilezles.org/articles/smin/. Licence: MIT for
  code snippets (as above).
- **Tetrahedron technique for numerical normals** (`calcNormal`,
  `estimateNormal`), which he credits to Paulo Falcao and Paul Malin.
  Scenes: Gyroid Tunnels, Liquid Chrome, and the flights Apollonian Foam,
  DIFS Tunnel, Folded Box Variants, Hypercomplex Slice, KIFS Fold, L-System
  Tube, Mandelbox, Mandelbulb, Glass Fractal DE, Polyfold, Quaternion Julia,
  Schottky Inversion, Triplex Mutation. Author: Inigo Quilez. Source:
  https://iquilezles.org/articles/normalsSDF/. Licence: MIT for code
  snippets (as above).
- **Soft shadows from a distance field** (`softShadow`). Scenes: the same
  thirteen flights. Author: Inigo Quilez. Source:
  https://iquilezles.org/articles/rmshadows/. Licence: MIT for code snippets
  (as above).
- **Domain warping** with the offsets 5.2/1.3, 1.7/9.2 and 8.3/2.8. Scene:
  Domain Warp. Author: Inigo Quilez. Source:
  https://iquilezles.org/articles/warp/. Licence: MIT for code snippets (as
  above).
- **Apollonian sphere-packing distance estimator** (fold with `fract`,
  invert, accumulate the scale), in the Apollonian Cell and Sphere Chain
  modes. Scene: Apollonian Foam Flight. Author: Inigo Quilez. Source: his
  Shadertoy shader "Apollonian" (2013) (Psychedelia's notices give no link).
  Licence: Creative Commons Attribution-NonCommercial-ShareAlike 3.0
  Unported (CC BY-NC-SA 3.0, the Shadertoy default),
  https://creativecommons.org/licenses/by-nc-sa/3.0/. This part of
  `apollonian-foam-flight.js` stays under CC BY-NC-SA 3.0;
  non-commercial use only. It is not under MIT.
- **Pseudo-Kleinian fold** (box fold, sphere inversion, scale
  accumulation), in the Knighty Foam, Pseudo-Kleinian Cathedral and Kleinian
  Box Hybrid modes. Scene: Apollonian Foam Flight.
  Author: Knighty, after Theli-at. Source:
  https://github.com/Syntopia/Fragmentarium/blob/master/Fragmentarium-Source/Examples/Knighty%20Collection/PseudoKleinian.frag.
  Licence: no licence stated at the source ("Made by Knighty"; the
  Fragmentarium application is offered under LGPL 2.1 or GPL 3). Used with
  credit; it remains under its author's terms.

Methods behind some of the scenes, written in Psychedelia's own code: Islamic
Star Patterns follows E. H. Hankin's polygons-in-contact method as described
by Craig S. Kaplan ("Islamic Star Patterns from Polygons in Contact",
Graphics Interface 2005); Complex Domain Colouring follows the domain
colouring method credited to Frank Farris; Black Hole bends rays by the
photon orbit equation derived by Otto Seiskari (oseiskar.github.io/black-hole);
Flame Variation Field and 3D Fractal Flame Volume Flight use the variation
functions of Scott Draves and Erik Reckase's fractal flame algorithm;
Mandelbulb Slice, Mandelbulb Flight and Triplex Mutation Flight are the
Mandelbulb of Daniel White and Paul Nylander; Burning Ship is Michael
Michelitsch and Otto E. Roessler's fractal; Lyapunov Fractal follows Mario
Markus; Phyllotaxis and L-System Tube Flight follow Prusinkiewicz and
Lindenmayer, "The Algorithmic Beauty of Plants". Every raymarched scene uses
sphere tracing (John C. Hart); the 3D flights follow Mikael Hvidtfeldt
Christensen's (Syntopia) distance-estimated 3D fractals series (the
Mandelbulb distance estimate takes the form given there); Mandelbox Flight,
Folded Box Variants Flight and Glass Fractal DE Flight are Tom Lowe's
Mandelbox; KIFS Fold Flight, Polyfold Flight, DIFS Tunnel Flight and the
endless scenes use kaleidoscopic IFS folds and Menger constructions (Tim
McGraw; Paul Bourke); several flight modes follow community formulas from
Fractal Forums as collected in Fragmentarium and Mandelbulber; Quaternion
Julia Flight and Hypercomplex Slice Flight follow Keenan Crane, "Ray Tracing
Quaternion Julia Sets on the GPU"; Strange Attractor Flight follows Edward
Lorenz (1963) and J. C. Sprott ("Some Simple Chaotic Flows", 1994); the sky
and planet in the endless scenes use Rayleigh and Mie scattering after Sean
O'Neil ("Accurate Atmospheric Scattering", GPU Gems 2), in Psychedelia's
own artist-adjustable version.
