#!/usr/bin/env node
/**
 * Copies the parts of Psychedelia Studio (same owner, MIT) that the
 * visualizer uses into src/visualizer/vendor/psychedelia/, wrapped as ES
 * modules, and writes manifest.json with each file's source path and SHA-256.
 *
 * Run it by hand when Psychedelia changes (it is not part of the build):
 *
 *   node scripts/import_psychedelia.mjs [path-to-psychedelia]
 *       imports every file again and writes a new manifest
 *   node scripts/import_psychedelia.mjs --only=tunnel,plasma [path]
 *       imports only those (scene names, or source paths); the other files
 *       and their manifest entries stay as they are
 *   node scripts/import_psychedelia.mjs --check-drift [path]
 *       changes nothing: lists the originals that changed (or went missing)
 *       since they were imported, with the last upstream commit that touched
 *       each, and any new Psychedelia scene file the Visualizer could take;
 *       warns of any listed original with changes not committed upstream
 *
 * The originals are read from Psychedelia's working tree, so an import
 * refuses to start (nothing written) while any original it would read has
 * changes not committed there, or git cannot say: only committed content
 * comes in. --allow-uncommitted imports them as they are anyway (the
 * manifest then marks each such file "uncommitted": true).
 *
 * npm test checks the vendored files against the manifest only, so
 * Psychedelia can move on without breaking it; the drift check is how its
 * changes are noticed. The path defaults to PSYCHEDELIA_ROOT, then to a
 * "psychedelia" folder next to this repository. The source folder is only
 * read, never written (git is asked read-only questions: log, status).
 *
 * Psychedelia's files are classic scripts: each defines one page global
 * (`var ShaderManager = (function () { ... })();`) and uses the others by
 * name. Each copy here becomes
 *
 *   export default function load(G) {
 *     var Renderer = G.Renderer;          // every Psychedelia global it names
 *     ...the original file, unchanged...
 *     return { ShaderManager: ShaderManager };   // the globals it defines
 *   }
 *
 * so the other modules come in through G instead of the page, and a module
 * that is not passed in reads as undefined (Psychedelia guards optional ones
 * with typeof). The original text is not edited, with two exceptions: a
 * non-ASCII character is written as a \u escape (this repository keeps its
 * source ASCII; in a string, template, regular expression or comment that
 * means the same thing), and the few PATCHES below, each listed in the
 * manifest and in the file's header. The manifest records the SHA-256 of the
 * original (line endings as LF) and of the text embedded here, and
 * tests/visualizer.test.js checks both.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = join(REPO, 'src', 'visualizer', 'vendor', 'psychedelia');

/** Scene files (each one registers one scene and needs only EffectRegistry).
 *  Each becomes its own lazily loaded chunk; src/visualizer/scenes.js lists
 *  them with their ids, names and cost classes. */
export const SCENE_FILES = Object.freeze([
  // Slice 2: the starter set.
  'plasma', 'tunnel', 'starfield', 'metaballs', 'voronoi', 'synthwave-grid',
  'truchet-tiles', 'quasicrystal', 'islamic-stars', 'spiral-galaxy', 'domain-colouring',
  // Slice 3: every other single-pass scene that needs only the registry (no
  // FractalFlight / FractalLab families, no custom render, no Renderer,
  // Controls, GlowLines, GpuSim, AudioReactor or Shadertoy runtime).
  'aurora', 'black-hole', 'burning-ship', 'color-cycle', 'domain-warp', 'droste',
  'endless-terrain', 'fire', 'flow-field', 'fractal-brownian', 'fractal-flame', 'glow-lab',
  'gyroid-tunnels', 'hyperbolic-tiling', 'julia-set', 'kaleidoscope', 'kleinian',
  'liquid-chrome', 'liquid-light', 'living-sun', 'lyapunov-fractal', 'mandelbrot-deep',
  'mandelbrot-power', 'mandelbrot', 'mandelbulb-slice', 'moire', 'nebula', 'newton-fractal',
  'nova-fractal', 'op-art', 'orbit-trap', 'perlin-noise', 'phoenix-fractal', 'phyllotaxis',
  'polar-spiral', 'rainy-window', 'rotozoom', 'seascape', 'sierpinski', 'sine-interference',
  'soap-bubbles', 'swirl', 'tricorn', 'underwater', 'water-ripple', 'wave-distort',
]);

/** Slice 7: the 3D fractal flights and the endless scenes. Besides the
 *  registry their files need Psychedelia's flight helpers (FractalFlight,
 *  fractal-flight-common.js: param builders and metadata, no drawing);
 *  endless-sky-crystal.js also needs EndlessScenes, which endless-scenes.js
 *  defines while it registers four scenes of its own (so one file there is
 *  several scenes). Each is still one shader with no render of its own;
 *  src/visualizer/scenes.js lists every scene they register. */
export const FLIGHT_FILES = Object.freeze([
  'mandelbulb-flight', 'triplex-mutation-flight', 'kifs-flight', 'difs-tunnel-flight',
  'mandelbox-flight', 'folded-box-variants-flight', 'quaternion-julia-flight',
  'hypercomplex-slice-flight', 'schottky-inversion-flight', 'apollonian-foam-flight',
  'polyfold-flight', 'fractal-flame-volume-flight', 'strange-attractor-flight',
  'lsystem-tube-flight', 'path-traced-fractal-flight',
]);
export const ENDLESS_FILES = Object.freeze(['endless-scenes', 'endless-sky-crystal']);
/** Slice 13: the four Fractal Lab scenes (each one shader, its formula mode
 *  compiled in; their params and presets come from Psychedelia's lab
 *  helpers, FractalLab in fractal-lab-common.js: builders and metadata, no
 *  drawing), Robot Foundry (one more endless scene, on EndlessScenes) and
 *  Cymatics (one shader; its setUniforms hook picks the plate's pattern from
 *  the Beat Reactor, AudioReactor, which the app gives as a stand-in over
 *  the reactor it already runs). */
export const LAB_FILES = Object.freeze(['escape-time-lab', 'analytic-field-lab', 'procedural-field-lab', 'fractal-flame-lab']);
export const EXTRA_SCENE_FILES = Object.freeze(['robot-foundry', 'cymatics']);
/** Slice 14: scenes that own their passes (a render of their own, no single
 *  shader), drawn by the app's host for them (visualizer/sim-host.js): the
 *  GPU simulations on Psychedelia's GpuSim (engine/gpu-sim.js; Physarum
 *  makes its own targets), and the frame-feedback scenes, whose Shadertoy
 *  pass graph the app gives as a small adapter
 *  (visualizer/shadertoy-adapter.js, on Psychedelia's ShadertoyCompiler)
 *  instead of Psychedelia's Shadertoy runtime. */
export const SIM_FILES = Object.freeze(['curl-silk', 'fluid-ink', 'lenia', 'physarum']);
/** (Psychedelia's Game of Life, its third, is left out: its board thins out
 *  to near black within a minute, with any of its colours.) */
export const FEEDBACK_FILES = Object.freeze(['feedback-loop', 'reaction-diffusion']);
export const PASS_FILES = Object.freeze([...SIM_FILES, ...FEEDBACK_FILES]);
/** The globals a scene that owns its passes may need: the registry and the
 *  host's stand-ins (sim-host.js) for GpuSim, Controls, Renderer and the
 *  Beat Reactor, and the adapter's ShadertoyEffectRunner and
 *  ShadertoyPassGraph. */
export const PASS_GLOBALS = Object.freeze(['EffectRegistry', 'GpuSim', 'Controls', 'Renderer', 'AudioReactor', 'PsyPalettes', 'ShadertoyEffectRunner', 'ShadertoyPassGraph']);
/** Not a Psychedelia global, but given to the simulations through G too:
 *  their Math, whose random() is the host's seeded one (each visit seeded
 *  afresh), so the flash check can draw a visit exactly as the tab does. */
export const SIM_EXTRA_GLOBALS = Object.freeze(['Math']);
/** The line-drawing scenes: each builds its curve or trajectory on the
 *  processor every frame as line segments and draws them with Psychedelia's
 *  GlowLines (engine/glow-lines.js: additive quads into a persistence
 *  target, then a composite over a background), on the app's line host
 *  (visualizer/line-host.js, on top of the host for scenes that own their
 *  passes). Kept apart from ALL_SCENE_FILES: visualizer/line-scenes.js
 *  lists them and holds them out of the tab until they are measured. */
export const LINE_FILES = Object.freeze(['epicycles', 'hopf', 'knots', 'lissajous', 'lorenz-attractor', 'polytopes', 'spirograph']);
/** The globals a line-drawing scene may need: the registry, GlowLines (the
 *  line host's), and the host's stand-ins for Controls, Renderer and the
 *  Beat Reactor. */
export const LINE_GLOBALS = Object.freeze(['EffectRegistry', 'GlowLines', 'Controls', 'Renderer', 'AudioReactor']);
/** The accumulating labs. Attractor Density Lab, Buddhabrot Lab and Flame
 *  Density Lab build their pictures point by point in Psychedelia's
 *  progressive density worker (workers/progressive-density-worker.js; the
 *  app starts it as a module worker, visualizer/density-worker.js, and
 *  gives the labs its own ProgressiveDensityRenderer,
 *  visualizer/density-host.js); IFS / L-System Lab draws its own lines and
 *  points into a persistence target, on the host for scenes that own their
 *  passes. Kept apart from ALL_SCENE_FILES: visualizer/accumulating-scenes.js
 *  lists them and holds them out of the tab until they are measured. */
export const DENSITY_FILES = Object.freeze(['attractor-density-lab', 'buddhabrot-lab', 'flam3-density-lab']);
export const ACCUMULATING_FILES = Object.freeze([...DENSITY_FILES, 'ifs-lsystem-lab']);
/** The globals an accumulating lab may need: the registry, the lab helpers,
 *  the host's stand-ins for Controls and Renderer, and the density host's
 *  ProgressiveDensityRenderer (PsyPalettes is not given: IFS / L-System Lab
 *  then offers its own palettes only). */
export const ACCUMULATING_GLOBALS = Object.freeze(['EffectRegistry', 'FractalLab', 'Controls', 'Renderer', 'ProgressiveDensityRenderer', 'PsyPalettes']);
/** Every scene file imported (SCENE_FILES, then FLIGHT_FILES, ENDLESS_FILES,
 *  LAB_FILES, EXTRA_SCENE_FILES and PASS_FILES). */
export const ALL_SCENE_FILES = Object.freeze([...SCENE_FILES, ...FLIGHT_FILES, ...ENDLESS_FILES, ...LAB_FILES, ...EXTRA_SCENE_FILES, ...PASS_FILES]);
/** The helper files those need (no scenes of their own). */
export const HELPER_FILES = Object.freeze(['fractal-flight-common', 'fractal-lab-common']);
/** The Psychedelia globals a scene file may need: the registry, the flight
 *  and lab helpers, and EndlessScenes (from endless-scenes.js). */
export const SCENE_GLOBALS = Object.freeze(['EffectRegistry', 'FractalFlight', 'FractalLab', 'EndlessScenes']);
/** Globals a scene's setUniforms hook may read while it draws (never while
 *  it registers): the Beat Reactor, and the Renderer it falls back to
 *  without one. The app gives the first as a stand-in over its own reactor
 *  (scene-renderer.js sceneAudio), so the second is never reached. */
export const HOOK_GLOBALS = Object.freeze(['AudioReactor', 'Renderer']);

/** What the visualizer needs, in Psychedelia's own load order (index.html):
 *  the shader manager, the Beat Reactor (audio-signal.js must load before
 *  audio-reactor.js, which reads AudioSignal.bands as it loads), the post FX
 *  library (its shader passes only: Psychedelia's post-process.js needs its
 *  Renderer, so the app runs the passes itself, visualizer/fx-chain.js), the
 *  effect registry, the flight helpers, then the scenes.
 *
 *  palettes.js (the shared palettes) goes to the post FX library only, for
 *  its Palette Map pass (visualizer/index.js gives it PsyPalettes; the FX
 *  chain binds the pass's look-up texture). The registry is not given it, so
 *  no scene's palette select grows (its extra entries would need a texture
 *  bound on every scene draw). */
export const FILES = Object.freeze([
  { source: 'src/engine/shader-manager.js', target: 'engine/shader-manager.js' },
  { source: 'src/engine/audio-signal.js', target: 'engine/audio-signal.js' },
  { source: 'src/engine/audio-reactor.js', target: 'engine/audio-reactor.js' },
  { source: 'src/engine/palettes.js', target: 'engine/palettes.js' },
  { source: 'src/engine/post-fx-library.js', target: 'engine/post-fx-library.js' },
  // The Canvas 2D overlays (slice 6): loaded only when one is chosen, a fresh
  // instance per load (visualizer/overlay-layer.js), drawn into the app's own
  // canvas (PATCHES), with the Beat Reactor given through the flash gate.
  { source: 'src/engine/overlays.js', target: 'engine/overlays.js' },
  // Slice 14: the simulations' toolkit, and the Shadertoy compiler the
  // feedback adapter builds its passes with (both loaded with those scenes).
  { source: 'src/engine/gpu-sim.js', target: 'engine/gpu-sim.js' },
  { source: 'src/engine/shadertoy-compiler.js', target: 'engine/shadertoy-compiler.js' },
  // The line drawer of the line-drawing scenes (loaded with them).
  { source: 'src/engine/glow-lines.js', target: 'engine/glow-lines.js' },
  { source: 'src/effects/registry.js', target: 'effects/registry.js' },
  ...HELPER_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
  ...ALL_SCENE_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
  ...LINE_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
  // The density labs' worker (loaded only in that worker).
  { source: 'src/workers/progressive-density-worker.js', target: 'workers/progressive-density-worker.js' },
  ...ACCUMULATING_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
]);

/** Code in the imported files that Psychedelia took from other people, as
 *  its THIRD_PARTY_NOTICES.md credits it (and a search of these files for
 *  credits, links and known routines). Borrowed code is ported with credit;
 *  the licence is quoted as the source states it, or
 *  "no licence stated at the source". Each piece goes into the wrapped
 *  file's header, and manifest.json `borrowed` lists every scene that
 *  carries borrowed code (the About page's credits are built from it, and
 *  `nonCommercial` / `noLicenceStated` say which scenes would have to go if
 *  the app were ever sold). CREDITS.md and public/THIRD_PARTY_NOTICES.txt
 *  carry one entry per piece. `files`: the Psychedelia sources it is in; in
 *  an engine file (shader-manager.js, post-fx-library.js) it reaches every
 *  scene ('*'). */
const IQ = 'Inigo Quilez';
const IQ_SNIPPETS = 'MIT for code snippets ("all technical code snippets you\'ll find are under the MIT license", https://iquilezles.org/articles/)';
const FLIGHTS_WITH_NORMALS = [
  'apollonian-foam-flight', 'difs-tunnel-flight', 'folded-box-variants-flight', 'hypercomplex-slice-flight', 'kifs-flight',
  'lsystem-tube-flight', 'mandelbox-flight', 'mandelbulb-flight', 'path-traced-fractal-flight', 'polyfold-flight',
  'quaternion-julia-flight', 'schottky-inversion-flight', 'triplex-mutation-flight',
];
const effects = (...names) => names.map((name) => `src/effects/${name}.js`);
export const BORROWED = Object.freeze([
  {
    id: 'webgl-noise', files: ['src/engine/shader-manager.js'],
    piece: '3D simplex noise (snoise, mod289, permute, taylorInvSqrt), the base of the shared fbm',
    author: 'Ian McEwan, Ashima Arts, with Stefan Gustavson', link: 'https://github.com/ashima/webgl-noise/blob/master/src/noise3D.glsl',
    licence: 'MIT License ("Copyright (C) 2011 Ashima Arts. All rights reserved. Distributed under the MIT License.")',
  },
  {
    id: 'hocevar-hsv', files: ['src/engine/shader-manager.js', 'src/engine/post-fx-library.js'],
    piece: 'RGB to HSV and HSV to RGB conversion (rgb2hsv, hsv2rgb, toHsv)',
    author: 'Sam Hocevar', link: 'https://stackoverflow.com/a/17897228', licence: 'WTFPL',
  },
  {
    // GlowLines (the line-drawing scenes) has its own copy: pal(), the same
    // form with two of his example parameter sets.
    id: 'iq-palette', files: ['src/engine/shader-manager.js', 'src/engine/glow-lines.js'],
    piece: 'cosine palette palette(), a + b * cos(6.28318 * (c * t + d)), and some of its example parameter sets',
    author: IQ, link: 'https://iquilezles.org/articles/palettes/', licence: IQ_SNIPPETS,
  },
  {
    id: 'narkowicz-aces', files: ['src/engine/shader-manager.js'],
    piece: 'ACES filmic tone-mapping curve fit (psyTonemap)',
    author: 'Krzysztof Narkowicz', link: 'https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/',
    licence: '"free to use under public domain CC0 or MIT license"',
  },
  {
    id: 'hoskins-hash', files: effects('endless-terrain', 'living-sun', 'nebula', 'endless-scenes', 'endless-sky-crystal', 'robot-foundry', 'curl-silk'),
    piece: '"Hash without Sine", with adjusted constants',
    author: 'David Hoskins', link: 'https://www.shadertoy.com/view/4djSRW', licence: 'MIT License, Copyright (c)2014 David Hoskins',
  },
  {
    id: 'iq-distance-functions',
    // Robot Foundry: the capsule (rfCapsule) and capped cylinder (rfCylinder).
    files: effects('sierpinski', 'apollonian-foam-flight', 'difs-tunnel-flight', 'folded-box-variants-flight', 'kifs-flight', 'mandelbox-flight', 'path-traced-fractal-flight', 'polyfold-flight', 'robot-foundry'),
    piece: 'distance functions sdBox, sdTorus, sdOctahedron (bound version), the 2D box, the capsule and the capped cylinder',
    author: IQ, link: 'https://iquilezles.org/articles/distfunctions/', licence: IQ_SNIPPETS,
  },
  {
    id: 'dobryakov-fluid', files: effects('fluid-ink'),
    piece: 'fluid solver passes: splat, curl, vorticity confinement, divergence with boundary reflection, Jacobi pressure, gradient subtract',
    author: 'Pavel Dobryakov', link: 'https://github.com/PavelDoGreat/WebGL-Fluid-Simulation',
    licence: 'MIT License, Copyright (c) 2017 Pavel Dobryakov',
  },
  {
    id: 'iq-smin', files: effects('liquid-chrome'),
    piece: 'polynomial smooth minimum smin', author: IQ, link: 'https://iquilezles.org/articles/smin/', licence: IQ_SNIPPETS,
  },
  {
    id: 'iq-normals', files: effects('gyroid-tunnels', 'liquid-chrome', ...FLIGHTS_WITH_NORMALS),
    piece: 'tetrahedron technique for numerical normals (calcNormal, estimateNormal), which he credits to Paulo Falcao and Paul Malin',
    author: IQ, link: 'https://iquilezles.org/articles/normalsSDF/', licence: IQ_SNIPPETS,
  },
  {
    id: 'iq-soft-shadows', files: effects(...FLIGHTS_WITH_NORMALS),
    piece: 'soft shadows from a distance field, min(res, k * h / t) (softShadow)',
    author: IQ, link: 'https://iquilezles.org/articles/rmshadows/', licence: IQ_SNIPPETS,
  },
  {
    id: 'iq-domain-warp', files: effects('domain-warp'),
    piece: 'noise-based domain warping with the offsets 5.2/1.3, 1.7/9.2 and 8.3/2.8',
    author: IQ, link: 'https://iquilezles.org/articles/warp/', licence: IQ_SNIPPETS,
  },
  {
    id: 'iq-apollonian', files: effects('apollonian-foam-flight'),
    piece: 'Apollonian sphere-packing distance estimator (fold with fract, invert, accumulate the scale), in the Apollonian Cell and Sphere Chain modes',
    author: IQ, link: null, linkNote: 'the Shadertoy shader "Apollonian" (2013); Psychedelia\'s notices give no link to it',
    licence: 'CC BY-NC-SA 3.0 (Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported, the Shadertoy default), https://creativecommons.org/licenses/by-nc-sa/3.0/',
    nonCommercial: true, shareAlike: true,
  },
  {
    id: 'knighty-pseudo-kleinian', files: effects('apollonian-foam-flight'),
    piece: 'pseudo-Kleinian fold (box fold, sphere inversion, scale accumulation), in the Knighty Foam, Pseudo-Kleinian Cathedral and Kleinian Box Hybrid modes',
    author: 'Knighty, after Theli-at',
    link: 'https://github.com/Syntopia/Fragmentarium/blob/master/Fragmentarium-Source/Examples/Knighty%20Collection/PseudoKleinian.frag',
    licence: 'no licence stated at the source ("Made by Knighty"; the Fragmentarium application is offered under LGPL 2.1 or GPL 3)',
    noLicenceStated: true,
  },
  // The shared palettes (palettes.js; the Palette Map effect only).
  {
    id: 'oklab', files: ['src/engine/palettes.js'],
    piece: 'Oklab colour space matrices (rgbToOklab, oklabToRgb), used to blend palette stops',
    author: 'Bjorn Ottosson', link: 'https://bottosson.github.io/posts/oklab/',
    licence: '"available in public domain"; also available under an MIT licence',
  },
  {
    id: 'bids-colormaps', files: ['src/engine/palettes.js'],
    piece: 'the Viridis, Magma, Inferno and Plasma palettes, approximate samples of those colour maps',
    author: 'Nathaniel J. Smith and Stefan van der Walt; Eric Firing for Viridis', link: 'https://github.com/BIDS/colormap',
    licence: 'CC0 ("released under the CC0 license / public domain dedication. We would appreciate credit if you use or redistribute these colormaps, but do not impose any legal restrictions.")',
  },
  {
    id: 'turbo', files: ['src/engine/palettes.js'],
    piece: 'the Turbo palette, approximate samples of that colour map',
    author: 'Anton Mikhailov, Google', link: 'https://gist.github.com/mikhailov-work/6a308c20e494d9e0ccc29036b28faa7a',
    licence: 'Apache License 2.0 ("Copyright 2019 Google LLC. SPDX-License-Identifier: Apache-2.0")',
  },
  {
    id: 'twilight', files: ['src/engine/palettes.js'],
    piece: 'the Twilight palette, approximate samples of that colour map',
    author: 'Bastian Bechtold', link: 'https://github.com/bastibe/twilight',
    licence: 'none stated at the source, which notes the map "has been merged into Matplotlib"; Matplotlib distributes it under the Matplotlib License (BSD-style; Copyright (c) 2012- Matplotlib Development Team)',
  },
  {
    id: 'cubehelix', files: ['src/engine/palettes.js'],
    piece: 'the Cubehelix palette, approximate samples of that colour map',
    author: 'D. A. Green', link: 'https://arxiv.org/abs/1108.5083',
    licence: 'none stated in the paper, which publishes the map as a formula; Matplotlib\'s implementation is under the Matplotlib License (BSD-style; Copyright (c) 2012- Matplotlib Development Team)',
  },
].map((piece) => Object.freeze({ ...piece, files: Object.freeze(piece.files) })));

/** The borrowed pieces (BORROWED) in Psychedelia file `source`. */
export const borrowedIn = (source) => BORROWED.filter((piece) => piece.files.includes(source));

/** Header lines naming the borrowed pieces in `source`. */
export function borrowedHeader(source) {
  const lines = [];
  for (const piece of borrowedIn(source)) {
    lines.push(` * BORROWED: ${piece.piece}.`);
    lines.push(` *   Author: ${piece.author}. Source: ${piece.link || piece.linkNote}.`);
    lines.push(` *   Licence: ${piece.licence}.${piece.shareAlike ? ' This part stays under that licence (non-commercial use only), not MIT.' : ''}`);
  }
  return lines;
}

/** Licence texts copied beside the modules. */
export const NOTICES = Object.freeze([
  { source: 'LICENSE', target: 'LICENSE.txt' },
  { source: 'lib/licenses/webgl-noise-LICENSE.txt', target: 'webgl-noise-LICENSE.txt' },
  { source: 'lib/licenses/WebGL-Fluid-Simulation-LICENSE.txt', target: 'WebGL-Fluid-Simulation-LICENSE.txt' },
]);

/** Changes made to an original while importing it, kept as few and small as
 *  possible (a look is tuned through scenes.js params first; a patch is only
 *  for what no param reaches). Each replaces `find`, which must occur exactly
 *  once in the original (LF), with `replace`. The manifest lists them per
 *  file, and the wrapped file's header says so.
 *
 *  (An earlier one, Tunnel's depth fade 0.1 -> 2.5, is in Psychedelia itself
 *  since its commit 410e10c.)
 *
 *  (Another, the dive iteration budget in whole steps of 60, is no longer
 *  needed since Psychedelia b4739fa: the fractals coloured the inside of the
 *  set from the last iterate, so each whole step of the growing budget
 *  recoloured it at once, a 3-5 Hz flicker in a dive. They now colour it from
 *  the orbit point closest to the origin, which holds still as steps are
 *  added (mandelbrot.js, burning-ship.js, tricorn.js, mandelbrot-power.js,
 *  mandelbrot-deep.js; orbit-trap.js colours by its trap). The long check
 *  (120 s, surge at its most, on the card) gives the same steps with or
 *  without it on every one of them.) */
/** Three 3D flights whose camera path runs into and through the fractal
 *  (Apollonian Foam, Folded Box Variants, Mandelbox; once held, scenes.js
 *  HELD_SCENES): Psychedelia's clear bubble around the camera turns the
 *  moment it is inside into one flat colour, reached in a frame or two (a
 *  step of light of up to 0.53). Here the whole picture fades into the
 *  scene's own background as the camera nears the surface, by how far the
 *  camera is from it (the scene's distance estimate at the camera, one more
 *  evaluation a pixel): fully clear from FLIGHT_CAMERA_NEAR[1] away, all
 *  background at FLIGHT_CAMERA_NEAR[0] or inside. Where that distance
 *  changes smoothly (these three) the picture changes over many frames. The
 *  other held flights' distance estimates jump from frame to frame (DIFS
 *  Tunnel 0.44 to 0.04, Hypercomplex Slice 0.46 to 0.04, at the camera), so
 *  a fade by it only adds steps there: they get none. */
export const FLIGHT_CAMERA_NEAR = Object.freeze([0.05, 0.3]);
/** Whole lines of a patch's text (each ends with a newline). */
const textLines = (...rows) => `${rows.join('\n')}\n`;
const NEAR_GLSL = `const float CAM_NEAR_IN = ${FLIGHT_CAMERA_NEAR[0].toFixed(3)};\nconst float CAM_NEAR_OUT = ${FLIGHT_CAMERA_NEAR[1].toFixed(3)};\n`;
/** [file, the scene's distance estimate] (each fades into its background(rd, t)) */
export const FLIGHT_CAMERA_SCENES = Object.freeze([
  ['apollonian-foam-flight', 'foamDE'],
  ['folded-box-variants-flight', 'foldedBoxDE'],
  ['mandelbox-flight', 'mandelboxDE'],
]);
const FLIGHT_CAMERA_PATCHES = FLIGHT_CAMERA_SCENES.flatMap(([name, de]) => [
  {
    source: `src/effects/${name}.js`,
    find: 'const float CAM_CLEAR = 0.05;\n',
    replace: `const float CAM_CLEAR = 0.05;\n${NEAR_GLSL}`,
    why: 'CAM_NEAR_IN, CAM_NEAR_OUT: where the picture fades as the camera nears the surface',
  },
  {
    source: `src/effects/${name}.js`,
    find: '    g_cam = ro;\n',
    replace: `    g_cam = ro;\n    float camNear = 1.0 - smoothstep(CAM_NEAR_IN, CAM_NEAR_OUT, ${de}(ro).dist);\n`,
    why: 'camNear: how near the camera is to the surface (1 at CAM_NEAR_IN or inside, 0 from CAM_NEAR_OUT)',
  },
  {
    source: `src/effects/${name}.js`,
    find: '    col = psyGamma(psyTonemap(col));\n    FRAG_OUT',
    replace: '    col = mix(col, background(rd, t), camNear);\n    col = psyGamma(psyTonemap(col));\n    FRAG_OUT',
    why: 'the picture fades into the background as the camera nears the fractal (its distance estimate at the camera, FLIGHT_CAMERA_NEAR), so passing through the surface is no pop of light',
  },
]);

export const PATCHES = Object.freeze([
  // The overlays draw into a canvas the app gives (init(host)): Psychedelia's
  // init() looks up #canvasWrap, adds a second (strobe) canvas, and adds a
  // window resize listener it never removes; its render() reads the layout
  // of #mainCanvas every drawn frame (syncPosition). Hosted, none of that
  // happens: no strobe layer (the Strobe overlay is not offered), no layout
  // reads, no listener; the app sizes and places the canvas. Without a host
  // argument it behaves as before.
  {
    source: 'src/engine/overlays.js',
    find: '    function init() {\n        canvas2d = document.createElement(\'canvas\');',
    replace: '    function init(host) {\n        if (host) { canvas2d = host; ctx = canvas2d.getContext(\'2d\'); return; }\n        canvas2d = document.createElement(\'canvas\');',
    why: 'init(host) draws into the canvas the app gives: no strobe canvas, no #canvasWrap lookup, no window resize listener',
  },
  {
    source: 'src/engine/overlays.js',
    find: '    function syncPosition() {\n        if (!canvas2d) return;',
    replace: '    function syncPosition() {\n        if (!canvas2d || !strobeCanvas) return;',
    why: 'hosted (no strobe canvas), syncPosition reads no layout: render() no longer calls getBoundingClientRect every frame',
  },
  // Lasers as beams the app draws (overlay-layer.js laserBeam: a soft strip
  // filled across a turned rectangle, no stroke): a canvas line wider than a
  // pixel, and its glow (a shadow blur), are drawn on the processor and were
  // most of the overlay's cost, so the app had them thin and without glow.
  // Without a beam function set, the lasers are stroked as before.
  {
    source: 'src/engine/overlays.js',
    find: '    var mods = {};\n',
    replace: '    var mods = {};\n    var beamSprite = null; // hosted: draws a laser beam without a stroke (setBeamSprite)\n',
    why: 'a beam function the app may set (setBeamSprite), none by default',
  },
  {
    source: 'src/engine/overlays.js',
    find: '            ctx.beginPath();\n            ctx.moveTo(x1, y1);\n            if (xm !== null) ctx.quadraticCurveTo(xm, ym, x2, y2);',
    replace: '            if (beamSprite && beamSprite(ctx, x1, y1, xm, ym, x2, y2, col, P.laser_thickness)) continue;\n            ctx.beginPath();\n            ctx.moveTo(x1, y1);\n            if (xm !== null) ctx.quadraticCurveTo(xm, ym, x2, y2);',
    why: 'renderLasers draws each beam with the app\'s beam function when one is set (it returns true when it drew it), else strokes it as before',
  },
  {
    source: 'src/engine/overlays.js',
    find: '        init: init,\n',
    replace: '        init: init,\n        setBeamSprite: function(fn) { beamSprite = typeof fn === \'function\' ? fn : null; },\n',
    why: 'setBeamSprite(fn) sets (or with no function clears) the beam function',
  },
  // Palette Map looks its colour up at fract(key * spread + cycle + offset):
  // where that index passes 1 it jumps from the palette's last colour to its
  // first, and a hue key jumps the same way at red (hue 1 is hue 0), so
  // neighbouring pixels of a smooth picture got colours from the two ends:
  // a hard seam (across Tunnel's rings, a ray from the middle). The hue is
  // read round its circle (0 at red, 1 at cyan, continuous) and the index
  // runs there and back (0 to 1 to 0), so neighbouring values always get
  // neighbouring colours.
  {
    source: 'src/engine/post-fx-library.js',
    find: "                '    float key = u_source < 0.5 ? lum : (u_source < 1.5 ? toHsv(c).x : lum * 0.5 + toHsv(c).x * 0.5);\\n' +\n",
    replace: "                '    float hue = 0.5 - 0.5 * cos(6.28318 * toHsv(c).x);\\n' +\n                '    float key = u_source < 0.5 ? lum : (u_source < 1.5 ? hue : lum * 0.5 + hue * 0.5);\\n' +\n",
    why: 'Palette Map reads the hue round its circle (no jump at red)',
  },
  {
    source: 'src/engine/post-fx-library.js',
    find: "                '    vec3 m = texture2D(u_lut, vec2(fract(key * u_spread + u_time * u_cycle + u_offset), 0.5)).rgb;\\n' +\n",
    replace: "                '    float at = key * u_spread + u_time * u_cycle + u_offset;\\n' +\n                '    vec3 m = texture2D(u_lut, vec2(1.0 - abs(1.0 - 2.0 * fract(at * 0.5)), 0.5)).rgb;\\n' +\n",
    why: 'Palette Map runs its index there and back along the palette (no jump from the last colour to the first)',
  },
  ...FLIGHT_CAMERA_PATCHES,
  // Cymatics keeps its pattern and timing in the file's own closure; as is,
  // a visit continues the last one (a fade left half done comes back). Each
  // visit starts as the first did: init and cleanup set them back to their
  // start. Its hook also made a small function every frame; it is made once.
  {
    source: 'src/effects/cymatics.js',
    find: '    var st = { n1: 2, m1: 5, n2: 2, m2: 5, blend: 1, fadeStart: 0, nextAt: 0, idx: 1, note: -1, noteSince: 0, lastPeak: 0 };\n',
    replace: '    var st = { n1: 2, m1: 5, n2: 2, m2: 5, blend: 1, fadeStart: 0, nextAt: 0, idx: 1, note: -1, noteSince: 0, lastPeak: 0 };\n    var ST_START = JSON.stringify(st);\n    function restart() { st = JSON.parse(ST_START); }\n    function setOne(gl, program, getLoc, name, v) { var l = getLoc(program, name); if (l !== null) gl.uniform1f(l, v); }\n',
    why: 'its pattern and timing go back to their start (restart) on each visit, and the uniform setter is made once (setOne)',
  },
  {
    source: 'src/effects/cymatics.js',
    find: '        var set = function(name, v) { var l = getLoc(program, name); if (l !== null) gl.uniform1f(l, v); };\n        set(\'u_n1\', st.n1); set(\'u_m1\', st.m1); set(\'u_n2\', st.n2); set(\'u_m2\', st.m2); set(\'u_blend\', e);\n',
    replace: '        setOne(gl, program, getLoc, \'u_n1\', st.n1); setOne(gl, program, getLoc, \'u_m1\', st.m1); setOne(gl, program, getLoc, \'u_n2\', st.n2);\n        setOne(gl, program, getLoc, \'u_m2\', st.m2); setOne(gl, program, getLoc, \'u_blend\', e);\n',
    why: 'the hook sets its uniforms through setOne: no function made per frame',
  },
  {
    source: 'src/effects/cymatics.js',
    find: '        setUniforms: setUniforms,\n',
    replace: '        setUniforms: setUniforms,\n        init: restart,\n        cleanup: restart,\n',
    why: 'init and cleanup restart it: every visit begins at the first pattern, no fade carried over',
  },
  // Curl-Noise Silk fills its trails on a fresh start with up to 12 extra
  // steps a frame (45 in all): a burst of work, every particle moved 13
  // times a frame. The host lets a frame run only a few steps (sim-host.js):
  // the same 45 extra steps, at most 2 a frame.
  {
    source: 'src/effects/curl-silk.js',
    find: '        var runs = step > 0 ? 1 + Math.min(S.warm, 12) : 0;\n',
    replace: '        var runs = step > 0 ? 1 + Math.min(S.warm, 2) : 0;\n',
    why: 'a fresh start fills its trails with at most 2 extra steps a frame (12 before): no burst of work on the first frames',
  },
  // A resize or a change of quality made the simulations' targets afresh:
  // the picture dropped to black and the simulation started again. GpuSim
  // gets carry(): the old target's picture stretched into the new one (a
  // pair's read side into the new read side), and each simulation hands its
  // live state on before it frees the old.
  {
    source: 'src/engine/gpu-sim.js',
    find: '    // Deletes targets, pairs and programs (any mix, nulls ignored).\n',
    replace: '    // The picture in target (or pair) from, stretched into to: linear\n'
      + '    // filtering, or nearest (32-bit floats cannot be filtered; positions\n'
      + '    // are not blended).\n'
      + '    function carry(gl, from, to, nearest) {\n'
      + '        if (!from || !to) return;\n'
      + '        if (from.read && to.read) { carry(gl, from.read, to.read, nearest); return; }\n'
      + '        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fb);\n'
      + '        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fb);\n'
      + '        gl.blitFramebuffer(0, 0, from.w, from.h, 0, 0, to.w, to.h, gl.COLOR_BUFFER_BIT, nearest ? gl.NEAREST : gl.LINEAR);\n'
      + '        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);\n'
      + '        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);\n'
      + '    }\n\n'
      + '    // Deletes targets, pairs and programs (any mix, nulls ignored).\n',
    why: 'carry(gl, from, to, nearest): a target\'s picture stretched into a new one (a resize keeps the picture)',
  },
  {
    source: 'src/engine/gpu-sim.js',
    find: '        release: release,\n',
    replace: '        release: release,\n        carry: carry,\n',
    why: 'GpuSim.carry',
  },
  {
    source: 'src/effects/curl-silk.js',
    find: '        destroy(gl);\n        S = { gl: gl, size: size, w: w, h: h, warm: 45 };\n',
    replace: '        var old = S && S.gl === gl ? S : null;\n        if (old) S = null; else destroy(gl);\n        S = { gl: gl, size: size, w: w, h: h, warm: 45 };\n',
    why: 'a new size keeps the old state until it is carried over (old)',
  },
  {
    source: 'src/effects/curl-silk.js',
    find: '        if (!S.pMove || !S.pDot || !S.pFade || !S.pDisplay || !S.state || !S.light) { destroy(gl); return false; }\n        return true;\n',
    replace: '        if (!S.pMove || !S.pDot || !S.pFade || !S.pDisplay || !S.state || !S.light) { destroy(gl); S = old; destroy(gl); return false; }\n'
      + '        if (old) {\n'
      + '            // The particles (positions, nearest) and their trails carried on.\n'
      + '            GpuSim.carry(gl, old.state, S.state, true);\n'
      + '            GpuSim.carry(gl, old.light, S.light);\n'
      + '            S.warm = 0;\n'
      + '            var made = S; S = old; destroy(gl); S = made;\n'
      + '        }\n'
      + '        return true;\n',
    why: 'a resize or a change of particle count carries its particles and trails over (no restart)',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '        destroy(gl);\n        S = { gl: gl, sw: sw, sh: sh, dw: sw * 2, dh: sh * 2, p: {}, prevMouse: null, kick: -1 };\n',
    replace: '        var old = S && S.gl === gl ? S : null;\n        if (old) S = null; else destroy(gl);\n        S = { gl: gl, sw: sw, sh: sh, dw: sw * 2, dh: sh * 2, p: {}, prevMouse: null, kick: -1 };\n',
    why: 'a new size keeps the old state until it is carried over (old)',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '        if (!S.vel || !S.pres || !S.dye || !S.div || !S.curl) { destroy(gl); return false; }\n        return true;\n',
    replace: '        if (!S.vel || !S.pres || !S.dye || !S.div || !S.curl) { destroy(gl); S = old; destroy(gl); return false; }\n'
      + '        if (old) {\n'
      + '            // The flow, its pressure and the ink carried on (both sides of the\n'
      + '            // ink: the display blends them).\n'
      + '            GpuSim.carry(gl, old.vel, S.vel);\n'
      + '            GpuSim.carry(gl, old.pres, S.pres);\n'
      + '            GpuSim.carry(gl, old.dye, S.dye);\n'
      + '            GpuSim.carry(gl, old.dye.write, S.dye.write);\n'
      + '            S.prevMouse = old.prevMouse; S.kick = old.kick; S.n = old.n; S.held = old.held; S.stepDt = old.stepDt;\n'
      + '            var made = S; S = old; destroy(gl); S = made;\n'
      + '        }\n'
      + '        return true;\n',
    why: 'a resize or a change of detail carries its flow and ink over (no restart)',
  },
  {
    source: 'src/effects/lenia.js',
    find: '        destroy(gl);\n        S = { gl: gl, w: w, h: h, rule: rule, kick: 0, nextRain: 0, reset: true, acc: 0 };\n',
    replace: '        var old = S && S.gl === gl ? S : null;\n        if (old) S = null; else destroy(gl);\n        S = { gl: gl, w: w, h: h, rule: rule, kick: 0, nextRain: 0, reset: true, acc: 0 };\n',
    why: 'a new size keeps the old world until it is carried over (old)',
  },
  {
    source: 'src/effects/lenia.js',
    find: '        if (!S.pUpdate || !S.pSeed || !S.pDisplay || !S.world) { destroy(gl); return false; }\n        return true;\n',
    replace: '        if (!S.pUpdate || !S.pSeed || !S.pDisplay || !S.world) { destroy(gl); S = old; destroy(gl); return false; }\n'
      + '        if (old) {\n'
      + '            // Its creatures carried on: no new seeding.\n'
      + '            GpuSim.carry(gl, old.world, S.world);\n'
      + '            S.reset = false; S.kick = old.kick; S.nextRain = old.nextRain; S.acc = old.acc;\n'
      + '            var made = S; S = old; destroy(gl); S = made;\n'
      + '        }\n'
      + '        return true;\n',
    why: 'a resize or a change of world size carries its creatures over (no restart)',
  },
  {
    source: 'src/effects/physarum.js',
    find: '        destroy(gl);\n        failedKey = key; failedGl = gl;\n',
    replace: '        var old = S && S.gl === gl ? S : null;\n        if (old) S = null; else destroy(gl);\n        failedKey = key; failedGl = gl;\n',
    why: 'a new size keeps the old trails until they are carried over (old)',
  },
  {
    source: 'src/effects/physarum.js',
    find: "        failedKey = ''; failedGl = null;\n        return true;\n",
    replace: "        failedKey = ''; failedGl = null;\n"
      + '        if (old) {\n'
      + '            // The trail field stretched into the new size; the agents (positions,\n'
      + '            // not a picture) kept as they are when their number is the same.\n'
      + '            var blit = function(from, to, w0, h0, w1, h1, filter) {\n'
      + '                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);\n'
      + '                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);\n'
      + '                gl.blitFramebuffer(0, 0, w0, h0, 0, 0, w1, h1, gl.COLOR_BUFFER_BIT, filter);\n'
      + '            };\n'
      + '            blit(old.fbT0, S.fbT0, old.tw, old.th, tw, th, gl.LINEAR);\n'
      + '            blit(old.fbT1, S.fbT1, old.tw, old.th, tw, th, gl.LINEAR);\n'
      + '            S.tflip = old.tflip;\n'
      + '            if (old.size === size && old.shape === shape) {\n'
      + '                blit(old.fbA0, S.fbA0, size, size, size, size, gl.NEAREST);\n'
      + '                blit(old.fbA1, S.fbA1, size, size, size, size, gl.NEAREST);\n'
      + '                S.flip = old.flip;\n'
      + '            }\n'
      + '            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);\n'
      + '            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);\n'
      + '            var made = S; S = old; destroy(gl); S = made;\n'
      + '        }\n'
      + '        return true;\n',
    why: 'a resize or a change of agent count carries its trails over, and its agents when their number is the same (no restart)',
  },
  // Fluid Ink's pressure solve ran 20 passes a frame, most of its 33: the
  // scene took 25% of a processor core, twice any other. It starts each
  // frame from 0.8 of the last frame's pressure, so fewer passes still settle.
  {
    source: 'src/effects/fluid-ink.js',
    find: '            for (var it = 0; it < 20; it++) {\n',
    replace: '            for (var it = 0; it < FLUID_PRESSURE_PASSES; it++) {\n',
    why: 'its pressure solve runs FLUID_PRESSURE_PASSES passes a frame (20 before), for the processor time',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '    var RES = [128, 192, 288];\n',
    replace: '    var RES = [128, 192, 288];\n    var FLUID_PRESSURE_PASSES = 10;\n    var FLUID_PRESSURE_FIRST = 2;\n',
    why: 'FLUID_PRESSURE_PASSES: 10; FLUID_PRESSURE_FIRST: 2 (the passes on the first half of a step)',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '        var step = Math.min(1 / 30, Math.max(0, dt));\n',
    replace: '        var step = Math.min(1 / 30, Math.max(0, dt));\n'
      + '        // A step is spread over two frames, with the time of both: its forces and\n'
      + '        // the first pressure passes on one (half 1), the rest of the pressure solve\n'
      + '        // and the advection on the next (half 2). A still frame steps nothing.\n'
      + '        if (step > 0) { S.held = (S.held || 0) + step; S.n = (S.n || 0) + 1; }\n'
      + '        var half = step > 0 ? 2 - S.n % 2 : 0;\n'
      + '        if (half === 1) { S.stepDt = Math.min(1 / 15, S.held); S.held = 0; }\n',
    why: 'a step is spread over two frames (half), with the time of both',
  },
  // The frame a step is taken shows the ink halfway between the step's
  // start and its end (the pair's other side holds the start), the next
  // frame its end: the ink moves every frame, as before.
  {
    source: 'src/effects/fluid-ink.js',
    find: "            'uniform sampler2D u_dye; uniform vec2 u_texel; uniform float u_shading; uniform float u_brightness; uniform vec3 u_bg;\\n' +\n",
    replace: "            'uniform sampler2D u_dye; uniform vec2 u_texel; uniform float u_shading; uniform float u_brightness; uniform vec3 u_bg;\\n' +\n"
      + "            'uniform sampler2D u_dye_prev; uniform float u_prev;\\n' +\n"
      + "            'vec3 dye(vec2 p) { return mix(texture(u_dye, p).rgb, texture(u_dye_prev, p).rgb, u_prev); }\\n' +\n",
    why: 'its display can show the ink between two steps (dye, u_prev)',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: "            '    vec3 c = texture(u_dye, v_uv).rgb;\\n' +\n"
      + "            '    float dx = lum(texture(u_dye, v_uv + vec2(u_texel.x, 0.0)).rgb) - lum(texture(u_dye, v_uv - vec2(u_texel.x, 0.0)).rgb);\\n' +\n"
      + "            '    float dy = lum(texture(u_dye, v_uv + vec2(0.0, u_texel.y)).rgb) - lum(texture(u_dye, v_uv - vec2(0.0, u_texel.y)).rgb);\\n' +\n",
    replace: "            '    vec3 c = dye(v_uv);\\n' +\n"
      + "            '    float dx = lum(dye(v_uv + vec2(u_texel.x, 0.0))) - lum(dye(v_uv - vec2(u_texel.x, 0.0)));\\n' +\n"
      + "            '    float dy = lum(dye(v_uv + vec2(0.0, u_texel.y))) - lum(dye(v_uv - vec2(0.0, u_texel.y)));\\n' +\n",
    why: 'its display reads the ink through dye()',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '        GpuSim.bind(gl, 0, S.dye.read.tex, dp.u.u_dye);\n',
    replace: '        GpuSim.bind(gl, 0, S.dye.read.tex, dp.u.u_dye);\n'
      + '        GpuSim.bind(gl, 1, S.dye.write.tex, dp.u.u_dye_prev);\n'
      + '        gl.uniform1f(dp.u.u_prev, S.mid ? 0.5 : 0);\n',
    why: 'the frame a step is taken shows the ink halfway through it',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '        if (half === 1) { S.stepDt = Math.min(1 / 15, S.held); S.held = 0; }\n',
    replace: '        if (half === 1) { S.stepDt = Math.min(1 / 15, S.held); S.held = 0; }\n        step = half > 0 ? S.stepDt : 0;\n        S.mid = half === 2;\n',
    why: 'both halves of a step use its time; S.mid: the ink was carried on this frame',
  },
  // Each half of a Fluid Ink step does its own part: the frame cost no
  // longer alternates between a whole step and none.
  {
    source: 'src/effects/fluid-ink.js',
    find: '        if (step > 0) {\n            // Emitters circle',
    replace: '        if (half === 1) {\n            // Emitters circle',
    why: 'the forces, the swirl and the divergence on the first half of a step',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: '            S.pres.swap();\n            for (var it = 0; it < FLUID_PRESSURE_PASSES; it++) {\n',
    replace: '            S.pres.swap();\n        }\n        if (half > 0) {\n'
      + '            for (var it = half === 1 ? 0 : FLUID_PRESSURE_FIRST; it < (half === 1 ? FLUID_PRESSURE_FIRST : FLUID_PRESSURE_PASSES); it++) {\n',
    why: 'the pressure solve shared between the two halves',
  },
  {
    source: 'src/effects/fluid-ink.js',
    find: "            }\n            pass(gl, 'gradient', S.vel.write,",
    replace: "            }\n        }\n        if (half === 2) {\n            pass(gl, 'gradient', S.vel.write,",
    why: 'the gradient and the advection on the second half of a step',
  },
  // GlowLines keeps its persistence target at the picture's size. Hosted,
  // the line host sets its size by the quality drawn now
  // (Renderer.getTrailScale, a share of each side); the lines keep their
  // width on the screen, and the composite still covers the whole picture.
  // Without getTrailScale it is the picture's size, as before.
  {
    source: 'src/engine/glow-lines.js',
    find: '            var W = canvas.width, H = canvas.height;\n            ensureFbo(gl, W, H);\n',
    replace: '            var W = canvas.width, H = canvas.height;\n            var TS = Renderer.getTrailScale ? Math.max(0.25, Math.min(1, Number(Renderer.getTrailScale()) || 1)) : 1;\n            var TW = Math.max(1, Math.round(W * TS)), TH = Math.max(1, Math.round(H * TS));\n            ensureFbo(gl, TW, TH);\n',
    why: 'the persistence target is sized by the host (Renderer.getTrailScale, 0.25 to 1 of each side), the picture\'s size without it',
  },
  {
    source: 'src/engine/glow-lines.js',
    find: "            ensureFbo(gl, TW, TH);\n",
    replace: "            if (!ensureFbo(gl, TW, TH)) { if (!st.fbo) return; TW = st.w; TH = st.h; }\n",
    why: 'when no new persistence target could be made, it draws on at the old size (nothing at all without one)',
  },
  {
    source: 'src/engine/glow-lines.js',
    find: '            gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);\n            gl.viewport(0, 0, W, H);\n',
    replace: '            gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);\n            gl.viewport(0, 0, TW, TH);\n',
    why: 'the lines are drawn into the persistence target at its own size',
  },
  // Its vertex array grew to exactly the segments asked for, so a count that
  // creeps up made a new array again and again; and each upload made a new
  // view of it. It grows by half again at least, and the upload reads the
  // array itself (WebGL 2's offset and length): nothing made per frame.
  {
    source: 'src/engine/glow-lines.js',
    find: '            if (!st.verts || st.verts.length < count * 24) st.verts = new Float32Array(Math.max(count, 1024) * 24);\n',
    replace: '            if (!st.verts || st.verts.length < count * 24) st.verts = new Float32Array(Math.max(count + (count >> 1), 1024) * 24);\n',
    why: 'its vertex array grows by half again at least (a slowly rising count no longer makes a new array each time)',
  },
  {
    source: 'src/engine/glow-lines.js',
    find: '                gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, count * 24), gl.DYNAMIC_DRAW);\n',
    replace: '                gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW, 0, count * 24);\n',
    why: 'the segments are uploaded from the array itself with an offset and a length (WebGL 2): no new view of it each frame',
  },
  // A new persistence target (a resize, a change of quality) was made
  // cleared, after the old one was freed: the trails dropped out for a
  // frame, and a target that could not be made lost them for good (and
  // its clear could reach the screen). The new one is made and checked
  // first, the old picture stretched into it, and only then is the old
  // one freed; on a failure the old one is kept (ensureFbo says false).
  {
    source: 'src/engine/glow-lines.js',
    find: "            if (st.fbo && st.w === w && st.h === h) return;\n"
      + "            drop(gl, 'Framebuffer', st.fbo);\n"
      + "            drop(gl, 'Texture', st.tex);\n"
      + "            st.tex = gl.createTexture();\n"
      + "            gl.bindTexture(gl.TEXTURE_2D, st.tex);\n"
      + "            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);\n"
      + "            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);\n"
      + "            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);\n"
      + "            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);\n"
      + "            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\n"
      + "            st.fbo = gl.createFramebuffer();\n"
      + "            gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);\n"
      + "            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, st.tex, 0);\n"
      + "            gl.clearColor(0, 0, 0, 1);\n"
      + "            gl.clear(gl.COLOR_BUFFER_BIT);\n"
      + "            gl.bindTexture(gl.TEXTURE_2D, null);\n"
      + "            st.w = w;\n"
      + "            st.h = h;\n",
    replace: "            if (st.fbo && st.w === w && st.h === h) return true;\n"
      + "            // A size that could not be made is not tried again every frame.\n"
      + "            if (st.failW === w && st.failH === h) return false;\n"
      + "            // The new target is made and checked first; the old one (and its\n"
      + "            // picture) is let go only once the picture is carried into it.\n"
      + "            var tex = gl.createTexture(), fbo = gl.createFramebuffer();\n"
      + "            var ok = !!(tex && fbo);\n"
      + "            if (ok) {\n"
      + "                gl.bindTexture(gl.TEXTURE_2D, tex);\n"
      + "                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);\n"
      + "                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);\n"
      + "                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);\n"
      + "                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);\n"
      + "                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\n"
      + "                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);\n"
      + "                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);\n"
      + "                ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;\n"
      + "            }\n"
      + "            gl.bindTexture(gl.TEXTURE_2D, null);\n"
      + "            if (!ok) {\n"
      + "                gl.bindFramebuffer(gl.FRAMEBUFFER, null);\n"
      + "                drop(gl, 'Framebuffer', fbo);\n"
      + "                drop(gl, 'Texture', tex);\n"
      + "                st.failW = w;\n"
      + "                st.failH = h;\n"
      + "                return false;\n"
      + "            }\n"
      + "            gl.clearColor(0, 0, 0, 1);\n"
      + "            gl.clear(gl.COLOR_BUFFER_BIT);\n"
      + "            if (st.fbo && gl.isFramebuffer(st.fbo) && gl.blitFramebuffer) {\n"
      + "                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, st.fbo);\n"
      + "                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);\n"
      + "                gl.blitFramebuffer(0, 0, st.w, st.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);\n"
      + "                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);\n"
      + "                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);\n"
      + "            }\n"
      + "            drop(gl, 'Framebuffer', st.fbo);\n"
      + "            drop(gl, 'Texture', st.tex);\n"
      + "            st.tex = tex;\n"
      + "            st.fbo = fbo;\n"
      + "            st.w = w;\n"
      + "            st.h = h;\n"
      + "            return true;\n",
    why: 'a new persistence target is made and checked before the old one goes, the trails stretched into it; on a failure the old one is kept',
  },
  // Physarum owed up to four steps after a late frame (each one a pass over
  // every agent and a point for each): the late frame was the heaviest, and
  // the next came late again. At most two a frame (a 30 fps frame's share).
  {
    source: 'src/effects/physarum.js',
    find: "        var steps = Math.max(0, Math.min(Math.floor(stepDebt + 0.3), perFrame * 4));\n",
    replace: "        var steps = Math.max(0, Math.min(Math.floor(stepDebt + 0.3), perFrame * 2));\n",
    why: 'at most two steps a frame (four before), so a late frame is not also the heaviest',
  },
  // A new number of agents (a change of quality) seeded them again: the
  // network was rebuilt over the next seconds. They are resampled instead.
  {
    source: 'src/effects/physarum.js',
    find: "    var FS_DIFFUSE = [\n",
    replace: "    // A new agent count from the old agents: every n-th going down, each repeated\n"
      + "    // with a small fixed offset (position and heading) going up.\n"
      + "    var FS_RESAMPLE = [\n"
      + "        '#version 300 es',\n"
      + "        'precision highp float;',\n"
      + "        'precision highp int;',\n"
      + "        'out vec4 o;',\n"
      + "        'uniform sampler2D u_from;',\n"
      + "        'uniform int u_fromSize;',\n"
      + "        'uniform int u_toSize;',\n"
      + "        'uniform vec2 u_spread;',\n"
      + "        'float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',\n"
      + "        'void main() {',\n"
      + "        '    ivec2 c = ivec2(gl_FragCoord.xy);',\n"
      + "        '    float ratio = float(u_fromSize * u_fromSize) / float(u_toSize * u_toSize);',\n"
      + "        '    int j = int(float(c.y * u_toSize + c.x) * ratio);',\n"
      + "        '    vec4 a = texelFetch(u_from, ivec2(j % u_fromSize, j / u_fromSize), 0);',\n"
      + "        '    if (ratio < 1.0) {',\n"
      + "        '        vec2 p = vec2(c);',\n"
      + "        '        a.xy = fract(a.xy + (vec2(h(p), h(p + 7.0)) - 0.5) * u_spread);',\n"
      + "        '        a.z = mod(a.z + (h(p + 3.0) - 0.5) * 0.5, 6.2831853);',\n"
      + "        '    }',\n"
      + "        '    o = a;',\n"
      + "        '}'\n"
      + "    ].join('\\n');\n"
      + "\n"
      + "    var FS_DIFFUSE = [\n",
    why: 'FS_RESAMPLE: a new number of agents from the old ones',
  },
  {
    source: 'src/effects/physarum.js',
    find: "                S.flip = old.flip;\n"
      + "            }\n",
    replace: "                S.flip = old.flip;\n"
      + "            } else if (old.shape === shape) {\n"
      + "                var rs = program(gl, VS_QUAD, FS_RESAMPLE);\n"
      + "                if (rs) {\n"
      + "                    gl.bindFramebuffer(gl.FRAMEBUFFER, S.fbA0);\n"
      + "                    gl.viewport(0, 0, size, size);\n"
      + "                    gl.useProgram(rs.p);\n"
      + "                    bindTex(gl, 0, old.flip ? old.agents1 : old.agents0, rs.u.u_from);\n"
      + "                    gl.uniform1i(rs.u.u_fromSize, old.size);\n"
      + "                    gl.uniform1i(rs.u.u_toSize, size);\n"
      + "                    gl.uniform2f(rs.u.u_spread, 2 / tw, 2 / th);\n"
      + "                    quad(gl, rs);\n"
      + "                    bindTex(gl, 0, null, null);\n"
      + "                    gl.useProgram(null);\n"
      + "                    gl.deleteProgram(rs.p);\n"
      + "                    S.flip = 0;\n"
      + "                }\n"
      + "            }\n",
    why: 'a new number of agents is resampled from the old (the network carries on)',
  },
  // Physarum's deposit was the same amount over a trail field of any size:
  // a smaller field (Low, a smaller window) came out brighter, a larger one
  // darker (0.12 at Medium, 0.20 on Low). Scaled with the field's area, as
  // at Medium in a 1920 x 1080 window (752 x 399).
  {
    source: 'src/effects/physarum.js',
    find: "            gl.uniform1f(u.u_amount, (v.deposit || 1) * (1 + kick * 1.5) * (512 * 512) / (S.size * S.size));\n",
    replace: "            gl.uniform1f(u.u_amount, (v.deposit || 1) * (1 + kick * 1.5) * (512 * 512) / (S.size * S.size) * (S.tw * S.th) / (752 * 399));\n",
    why: 'its deposit scales with the trail field area, so a change of size or quality keeps its brightness',
  },
  // Fourier Epicycles, Hopf Fibration, Knots & Surfaces and 4D Polytopes
  // worked out their own time step from the clock: 0.016 s on a still
  // first frame, and up to 0.1 s after a stall (past the host's limit).
  // They take the one the host gives (sim-host.js), as the others do.
  {
    source: 'src/effects/epicycles.js',
    find: "    function render(gl, program, time) {\n",
    replace: "    function render(gl, program, time, hostDt) {\n",
    why: 'its render takes the host\'s time step',
  },
  {
    source: 'src/effects/epicycles.js',
    find: "        var dt = lastTime === null ? 0.016 : Math.max(0, Math.min(0.1, time - lastTime));\n",
    replace: "        var dt = Math.max(0, Math.min(0.1, Number(hostDt) || 0));\n",
    why: 'it moves by the host\'s time step (none on a still frame, at most the host\'s limit after a stall), not its own',
  },
  {
    source: 'src/effects/hopf.js',
    find: "    function render(gl, program, time) {\n",
    replace: "    function render(gl, program, time, hostDt) {\n",
    why: 'its render takes the host\'s time step',
  },
  {
    source: 'src/effects/hopf.js',
    find: "        var dt = lastTime === null ? 0.016 : Math.max(0, Math.min(0.1, time - lastTime));\n",
    replace: "        var dt = Math.max(0, Math.min(0.1, Number(hostDt) || 0));\n",
    why: 'it moves by the host\'s time step (none on a still frame, at most the host\'s limit after a stall), not its own',
  },
  {
    source: 'src/effects/knots.js',
    find: "    function render(gl, program, time) {\n",
    replace: "    function render(gl, program, time, hostDt) {\n",
    why: 'its render takes the host\'s time step',
  },
  {
    source: 'src/effects/knots.js',
    find: "        var dt = lastTime === null ? 0.016 : Math.max(0, Math.min(0.1, time - lastTime));\n",
    replace: "        var dt = Math.max(0, Math.min(0.1, Number(hostDt) || 0));\n",
    why: 'it moves by the host\'s time step (none on a still frame, at most the host\'s limit after a stall), not its own',
  },
  {
    source: 'src/effects/polytopes.js',
    find: "    function render(gl, program, time) {\n",
    replace: "    function render(gl, program, time, hostDt) {\n",
    why: 'its render takes the host\'s time step',
  },
  {
    source: 'src/effects/polytopes.js',
    find: "        var dt = lastTime === null ? 0.016 : Math.max(0, Math.min(0.1, time - lastTime));\n",
    replace: "        var dt = Math.max(0, Math.min(0.1, Number(hostDt) || 0));\n",
    why: 'it moves by the host\'s time step (none on a still frame, at most the host\'s limit after a stall), not its own',
  },
  // The density worker answers each request with one slice of work. Its own
  // hard limit for a slice is 80 ms; the app's density host asks for less
  // (visualizer/density-host.js: the slice is part of its duty cycle) and
  // needs to know how long the slice took.
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('        state.deadline = started + 80;'),
    replace: textLines('        state.deadline = started + Math.min(80, Math.max(1, finite(message.deadlineMs, 80)));'),
    why: 'the host can set a slice\'s hard time limit lower (message.deadlineMs, at most the 80 ms it was)',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines("            workerStatus: 'ready',", '            image: mapped.image.buffer'),
    replace: textLines("            workerStatus: 'ready',", '            workMs: Date.now() - started,', '            image: mapped.image.buffer'),
    why: 'each frame says how long its slice took (workMs, from the request to the reply), for the host\'s duty cycle',
  },
  // It made a new pixel buffer for every frame; the host sends the last one
  // back (transferred) to be filled again.
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('    function tonemap(message) {'),
    replace: textLines(
      '    // The host may send the last frame\'s pixels back (message.image, an',
      '    // ArrayBuffer of the right size, transferred): they are filled again in',
      '    // place instead of a new buffer each frame.',
      '    function frameImage(message, bytes) {',
      '        var buffer = message.image;',
      '        if (buffer && buffer.byteLength === bytes) {',
      '            var reused = new Uint8ClampedArray(buffer);',
      '            reused.fill(0);',
      '            return reused;',
      '        }',
      '        return new Uint8ClampedArray(bytes);',
      '    }',
      '',
      '    function tonemap(message) {',
    ),
    why: 'frameImage(): the pixels sent back by the host (message.image) are filled again in place',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('        var image = new Uint8ClampedArray(state.width * state.height * 4);'),
    replace: textLines('        var image = frameImage(message, state.width * state.height * 4);'),
    why: 'a frame\'s pixels go into the buffer sent back by the host when there is one (no new buffer each frame)',
  },
  // The white point (which sets the whole picture's brightness) came from a
  // different sample of pixels each frame, so the brightness of a picture
  // still filling in moved a little from frame to frame; and the sample was
  // a new array each frame.
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('    function robustWhitePoint(max) {'),
    replace: textLines(
      '    // The lit pixels sampled for the white point, in one array kept from',
      '    // frame to frame.',
      '    var litBuffer = null;',
      '    function litSamples(count) {',
      '        if (!litBuffer || litBuffer.length < count) litBuffer = new Float32Array(count);',
      '        return litBuffer;',
      '    }',
      '',
      '    function robustWhitePoint(max) {',
    ),
    why: 'litSamples(): one array for the white point\'s sample, kept from frame to frame',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines(
      '        var lit = [];',
      '        var offset = (state.frameCount * 7919) % Math.max(1, Math.floor(stride));',
      '        for (var i = 0; i < sampleCount; i++) {',
      '            var idx = Math.min(n - 1, Math.floor(i * stride) + offset);',
      '            var v = Math.max(state.r[idx], state.g[idx], state.b[idx]);',
      '            if (v > 0) lit.push(v);',
      '        }',
      '        if (lit.length < 32) return max;',
      '        lit.sort(function(a, b) { return a - b; });',
      '        var p = lit[Math.floor((lit.length - 1) * 0.992)];',
    ),
    replace: textLines(
      '        var lit = litSamples(sampleCount);',
      '        var litCount = 0;',
      '        var offset = 0;',
      '        for (var i = 0; i < sampleCount; i++) {',
      '            var idx = Math.min(n - 1, Math.floor(i * stride) + offset);',
      '            var v = Math.max(state.r[idx], state.g[idx], state.b[idx]);',
      '            if (v > 0) lit[litCount++] = v;',
      '        }',
      '        if (litCount < 32) return max;',
      '        var sorted = lit.subarray(0, litCount).sort();',
      '        var p = sorted[Math.floor((litCount - 1) * 0.992)];',
    ),
    why: 'the white point is taken from the same pixels every frame (no step in brightness from a different sample), in the kept array',
  },
  // IFS / L-System Lab built its whole geometry on the processor every frame
  // (up to 30000 points and 16000 line segments, with new small arrays for
  // each and its L-system strings), uploaded it again and drew it into its
  // persistence target. Here it is built and uploaded only when something
  // it is built from changes; with nothing moving (the app holds its motion
  // still, visualizer/accumulating-scenes.js) that is once a look, and once
  // the persistence target has settled only the composite is drawn.
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('    function render(gl, program, time) {'),
    replace: textLines(
      '    // The geometry is built again only when something it is built from',
      '    // changed; with no motion (Motion Rate 0) it is the same every frame.',
      '    // The style and the size are in the list too: after any change the',
      '    // persistence target is drawn into until it has settled again',
      '    // (SETTLE_FRAMES), then only composited.',
      "    var GEOMETRY_INPUTS = ['mode', 'depth', 'growth', 'pointCount', 'thickness', 'angle', 'spread', 'lean', 'curl',",
      "        'branchScale', 'growthSpeed', 'sway', 'swaySpeed', 'rollSpeed', 'zoomSpeed', 'zoom', 'panX', 'panY',",
      "        'rotation', 'palette', 'colorSpeed', 'glow', 'fade', 'trails', 'motionTime', 'canvasWidth',",
      "        'canvasHeight', 'viewRotation', 'viewZoom'];",
      '    var SETTLE_FRAMES = 240;',
      '    function geometryChanged(p) {',
      '        var last = state.builtFrom;',
      '        var changed = !last;',
      '        if (!last) last = state.builtFrom = {};',
      '        for (var i = 0; i < GEOMETRY_INPUTS.length; i++) {',
      '            var name = GEOMETRY_INPUTS[i];',
      '            if (last[name] !== p[name]) {',
      '                last[name] = p[name];',
      '                changed = true;',
      '            }',
      '        }',
      '        return changed;',
      '    }',
      '',
      '    function render(gl, program, time) {',
    ),
    why: 'geometryChanged(): the geometry, its upload and the persistence passes follow only a change of what they are made from (GEOMETRY_INPUTS, SETTLE_FRAMES)',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('        state.pointCount = 0;', '        state.lineVertCount = 0;', '    }', '', '    function values() {'),
    replace: textLines(
      '        state.pointCount = 0;',
      '        state.lineVertCount = 0;',
      '        state.builtFrom = null;',
      '        state.built = 0;',
      '        state.linesFor = -1;',
      '        state.pointsFor = -1;',
      '        state.settled = 0;',
      '    }',
      '',
      '    function values() {',
    ),
    why: 'cleanup() forgets what the geometry was built from, so a new visit builds it again',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('        p.viewTime = time;', '        buildGeometry(p, motionTime);'),
    replace: textLines(
      '        p.viewTime = time;',
      '        p.motionTime = motionTime;',
      '        p.canvasWidth = canvas.width;',
      '        p.canvasHeight = canvas.height;',
      '        p.viewRotation = Renderer.getRotation ? Renderer.getRotation() : 0;',
      '        p.viewZoom = Renderer.getEffectiveViewZoom ? Renderer.getEffectiveViewZoom(time) : 1;',
      '        if (geometryChanged(p)) {',
      '            buildGeometry(p, motionTime);',
      '            state.built++;',
      '            state.settled = 0;',
      '        }',
    ),
    why: 'the geometry is built only when what it is built from changed',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('        var cl = state.compLoc;', '        gl.useProgram(state.compositeProgram);', '        gl.enable(gl.BLEND);'),
    replace: textLines(
      '        var cl = state.compLoc;',
      '        if (state.settled < SETTLE_FRAMES) {',
      '        state.settled++;',
      '        gl.useProgram(state.compositeProgram);',
      '        gl.enable(gl.BLEND);',
    ),
    why: 'the persistence target is faded and drawn into only until it has settled after a change',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('        // 3. Composite over the background.'),
    replace: textLines('        }', '', '        // 3. Composite over the background.'),
    why: 'the end of the passes drawn only until the persistence target has settled',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('            var quadVerts = buildQuads(p.thickness, canvas);'),
    replace: textLines(
      '            var linesFresh = state.linesFor !== state.built;',
      '            if (linesFresh) {',
      '                state.quadVerts = buildQuads(p.thickness, canvas);',
      '                state.linesFor = state.built;',
      '            }',
      '            var quadVerts = state.quadVerts;',
    ),
    why: 'the line quads are made again only for new geometry',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('            gl.bufferData(gl.ARRAY_BUFFER, state.quads.subarray(0, quadVerts * FLOATS_PER_QUAD_VERT), gl.DYNAMIC_DRAW);'),
    replace: textLines('            if (linesFresh) gl.bufferData(gl.ARRAY_BUFFER, state.quads.subarray(0, quadVerts * FLOATS_PER_QUAD_VERT), gl.DYNAMIC_DRAW);'),
    why: 'the line quads are uploaded only when they were made again',
  },
  {
    source: 'src/effects/ifs-lsystem-lab.js',
    find: textLines('            gl.bufferData(gl.ARRAY_BUFFER, state.points.subarray(0, state.pointCount * 3), gl.DYNAMIC_DRAW);'),
    replace: textLines(
      '            if (state.pointsFor !== state.built) {',
      '                gl.bufferData(gl.ARRAY_BUFFER, state.points.subarray(0, state.pointCount * 3), gl.DYNAMIC_DRAW);',
      '                state.pointsFor = state.built;',
      '            }',
    ),
    why: 'the points are uploaded only for new geometry',
  },
  // The white point came from the picture so far at every reply: when 32
  // lit pixels were first sampled it switched from the brightest pixel to
  // a percentile, and a pixel that grew hot moved it too, so the pixels
  // already there changed brightness at once. The worker now says its white
  // point as a multiple of the mean lit pixel (which grows with the picture
  // as it fills evenly) and uses the multiple the host sends, eased from
  // reply to reply (visualizer/density-host.js easeWhiteScale).
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines(
      '    function maxValue() {',
      '        var max = 0;',
      '        for (var i = 0; i < state.r.length; i++) {',
      '            max = Math.max(max, state.r[i], state.g[i], state.b[i]);',
      '        }',
      '        return max;',
      '    }',
    ),
    replace: textLines(
      '    // The mean of the lit pixels (each by its brightest channel), kept with',
      '    // the maximum: the white point is eased as a multiple of it.',
      '    var litMean = 0;',
      '    function maxValue() {',
      '        var max = 0;',
      '        var sum = 0;',
      '        var count = 0;',
      '        for (var i = 0; i < state.r.length; i++) {',
      '            var v = Math.max(state.r[i], state.g[i], state.b[i]);',
      '            if (v > max) max = v;',
      '            if (v > 0) { sum += v; count++; }',
      '        }',
      '        litMean = count ? sum / count : 0;',
      '        return max;',
      '    }',
    ),
    why: 'the mean lit pixel is found with the brightest (litMean), for the white point the host eases',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('        var white = robustWhitePoint(max);'),
    replace: textLines(
      '        var measured = robustWhitePoint(max);',
      '        // The host eases the white point between replies (message.whiteScale,',
      '        // a multiple of the mean lit pixel); without one, its own measure.',
      '        var hostScale = finite(message.whiteScale, 0);',
      '        var white = hostScale > 0 && litMean > 0 ? Math.min(max, Math.max(max * 0.015, litMean * hostScale, 0.0001)) : measured;',
    ),
    why: 'the white point the host sends (message.whiteScale, eased from reply to reply) is used when there is one',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('        return {', '            image: image,', '            maxValue: max', '        };'),
    replace: textLines('        return {', '            image: image,', '            maxValue: max,', '            whiteScale: litMean > 0 ? measured / litMean : 0', '        };'),
    why: 'the white point it measured, as a multiple of the mean lit pixel',
  },
  {
    source: 'src/workers/progressive-density-worker.js',
    find: textLines('            maxValue: mapped.maxValue,'),
    replace: textLines('            maxValue: mapped.maxValue,', '            whiteScale: mapped.whiteScale,'),
    why: 'each frame says the white point it measured (whiteScale), for the host to ease',
  },
]);

/** `lf` (an original, LF) with its PATCHES applied. Throws when a patch's
 *  text is not found exactly once (Psychedelia changed: look again). */
export function applyPatches(source, lf) {
  let text = lf;
  const applied = [];
  for (const patch of PATCHES) {
    if (patch.source !== source) continue;
    const at = text.indexOf(patch.find);
    if (at < 0 || text.indexOf(patch.find, at + 1) >= 0) {
      throw new Error(`${source}: the patch text "${patch.find}" is not there exactly once`);
    }
    text = text.slice(0, at) + patch.replace + text.slice(at + patch.find.length);
    applied.push({ find: patch.find, replace: patch.replace, why: patch.why });
  }
  return { text, applied };
}

export const BEGIN = (source) => `/* ===== BEGIN ${source} ===== */`;
export const END = (source) => `/* ===== END ${source} ===== */`;

export const toLf = (text) => text.replace(/\r\n?/g, '\n');
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Every non-ASCII character as a JavaScript \u escape. */
export function escapeNonAscii(text) {
  let count = 0;
  const out = text.replace(/[^\x00-\x7f]/gu, (ch) => {
    count += 1;
    const code = ch.codePointAt(0);
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
  return { text: out, count };
}

/** Names a file defines as page globals (`var X =` at the start of a line). */
export function definedGlobals(text) {
  return [...text.matchAll(/^var\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((match) => match[1]);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** All of Psychedelia's page globals, from every script under src/. */
export function allGlobals(root) {
  const names = new Set();
  for (const path of walk(join(root, 'src'))) {
    for (const name of definedGlobals(readFileSync(path, 'utf8'))) names.add(name);
  }
  return [...names].sort();
}

/** The wrapped module for one file. `crlf` writes CRLF like the rest of src/. */
export function wrap({ source, original, globals, crlf = true }) {
  const name = source.replace(/^src\/effects\//, '').replace(/\.js$/, '');
  if (SIM_FILES.includes(name)) globals = [...new Set([...globals, ...SIM_EXTRA_GLOBALS])].sort();
  const lf = toLf(original);
  if (lf.charCodeAt(0) === 0xfeff) throw new Error(`${source} starts with a byte order mark`);
  const patched = applyPatches(source, lf);
  const escaped = escapeNonAscii(patched.text);
  const count = escaped.count;
  // Embedded as whole lines (a missing last newline is the only addition).
  const body = escaped.text.endsWith('\n') ? escaped.text : `${escaped.text}\n`;
  const provides = definedGlobals(lf);
  const needs = globals.filter((name) => !provides.includes(name)
    && new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(lf));
  const lines = [
    '/* GENERATED by scripts/import_psychedelia.mjs. Do not edit; run the script again.',
    ` * From Psychedelia Studio, ${source}`,
    ' * Copyright (c) 2026 aivrar. MIT License: src/visualizer/vendor/psychedelia/LICENSE.txt',
    ` * SHA-256 of the original (LF line endings): ${sha256(lf)}`,
    ' * The text between the BEGIN and END lines is that file unchanged, except that',
    ' * any non-ASCII character is written as a \\u escape. It was a classic script;',
    ...(patched.applied.length
      ? [
        ' * here the Psychedelia modules it names come in through G.',
        ...patched.applied.map((patch) => ` * PATCHED on import (scripts/import_psychedelia.mjs PATCHES): ${patch.why}.`),
      ]
      : [' * here the Psychedelia modules it names come in through G.']),
    ...borrowedHeader(source),
    ' */',
    'export default function load(G) {',
    ...needs.map((name) => `var ${name} = G.${name};`),
    BEGIN(source),
    body.slice(0, -1),
    END(source),
    `return { ${provides.map((name) => `${name}: ${name}`).join(', ')} };`,
    '}',
    '',
  ];
  const text = lines.join('\n');
  return {
    text: crlf ? text.replace(/\n/g, '\r\n') : text,
    entry: {
      source,
      sha256: sha256(lf),
      bodySha256: sha256(body),
      bytes: Buffer.byteLength(lf, 'utf8'),
      asciiEscapes: count,
      needs,
      provides,
      ...(patched.applied.length ? { patches: patched.applied } : {}),
    },
  };
}

/** The embedded original between the markers of a wrapped module (LF). */
export function embeddedBody(wrapped, source) {
  const text = toLf(wrapped);
  const begin = text.indexOf(`${BEGIN(source)}\n`);
  const end = text.lastIndexOf(`\n${END(source)}`);
  if (begin < 0 || end < begin) return null;
  return `${text.slice(begin + BEGIN(source).length + 1, end)}\n`;
}

/** Read-only git questions about the Psychedelia checkout at `root`; null
 *  when git or the checkout is not there. */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

/** Where an original came from: the last commit that touched it, and
 *  whether it has changes not committed on top of that. */
export function upstreamOf(root, source) {
  const last = git(root, ['log', '-1', '--format=%H %cs %s', '--', source]);
  if (last === null) return null;
  const status = git(root, ['status', '--porcelain', '--', source]) || '';
  const [commit = null, date = null, ...subject] = last.split(' ');
  return { commit: commit || null, date, subject: subject.join(' ') || null, uncommitted: status !== '' };
}

/** The originals among `sources` (paths in Psychedelia) with changes not
 *  committed at `root` (changed, staged, new or deleted); null when git
 *  cannot say (no git, or not a checkout). */
export function uncommittedSources(root, sources) {
  let status;
  try {
    // Untrimmed (a status line may start with a space), NUL-separated: "XY path".
    status = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...sources], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return null;
  }
  const dirty = new Set();
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length < 4) continue;
    dirty.add(parts[i].slice(3));
    if (/^[RC]/.test(parts[i])) dirty.add(parts[(i += 1)]); // a rename's old path follows
  }
  return sources.filter((source) => dirty.has(source));
}

/** Reads the originals for an import, after making sure they are committed
 *  upstream (uncommittedSources); throws, naming them, when they are not
 *  and `allowUncommitted` is not set. Returns Map(source -> text). */
export function readOriginals(root, sources, { allowUncommitted = false } = {}) {
  if (!allowUncommitted) {
    const dirty = uncommittedSources(root, sources);
    if (dirty === null) {
      throw new Error(`Cannot tell whether the originals at ${root} are committed (git did not answer). Pass --allow-uncommitted to import them as they are.`);
    }
    if (dirty.length) {
      throw new Error(`Not imported: changes not committed in Psychedelia: ${dirty.join(', ')}. Commit them there first, or pass --allow-uncommitted.`);
    }
  }
  return new Map(sources.map((source) => [source, readFileSync(join(root, ...source.split('/')), 'utf8')]));
}

/** Does `text` (a classic script) name page global `name`? */
const names = (text, name) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
/** What the stand-in ShadertoyEffectRunner.make() returns while a scene
 *  file is read (sceneDefinitions): the adapter's hooks, none drawing. */
export const STAND_IN_RUNNER = Object.freeze({
  init() {}, cleanup() {}, render() {}, reset() {}, getDiagnostics: () => null,
});

/** Does `text` use global `name` (a member, a call, or typeof)? */
const usesGlobal = (text, name) => {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(`(^|[^\\w$.])${n}\\s*[.([]|typeof\\s+${n}(?![\\w$])`).test(text);
};

/** The scenes each scene file in Psychedelia registers: Map(file name
 *  without .js -> [definition]), for the files that need only SCENE_GLOBALS
 *  and load (classic scripts run with a recording registry, the real flight
 *  helpers and, from endless-scenes.js, the real EndlessScenes). */
export function sceneDefinitions(root) {
  const globals = allGlobals(root);
  const dir = join(root, 'src', 'effects');
  const read = (name) => (existsSync(join(dir, `${name}.js`)) ? readFileSync(join(dir, `${name}.js`), 'utf8') : null);
  let FractalFlight;
  let FractalLab;
  let EndlessScenes;
  try {
    const common = read('fractal-flight-common');
    if (common) FractalFlight = new Function(`${common}\nreturn FractalFlight;`)();
    const lab = read('fractal-lab-common');
    if (lab) FractalLab = new Function(`${lab}\nreturn FractalLab;`)();
    const endless = read('endless-scenes');
    if (endless && FractalFlight) {
      EndlessScenes = new Function('EffectRegistry', 'FractalFlight', `${endless}\nreturn EndlessScenes;`)({ register() {} }, FractalFlight);
    }
  } catch (_) {}
  const out = new Map();
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.js')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    const provides = definedGlobals(text);
    // Named as a global is used (Name.x, Name(, typeof Name), not a word in a
    // label ("Follow Music" is not the Music engine).
    const needs = globals.filter((g) => !provides.includes(g) && names(text, g) && usesGlobal(text, g));
    // A hook's globals are read only while it draws (HOOK_GLOBALS); a shader
    // scene with a render of its own is left out below (simpleSceneFiles).
    const name = file.replace(/\.js$/, '');
    const ownsPasses = PASS_FILES.includes(name);
    const drawsLines = LINE_FILES.includes(name);
    const accumulates = ACCUMULATING_FILES.includes(name);
    if (drawsLines && needs.some((g) => !LINE_GLOBALS.includes(g))) continue;
    if (accumulates && needs.some((g) => !ACCUMULATING_GLOBALS.includes(g))) continue;
    if (!drawsLines && !accumulates && !ownsPasses && needs.some((g) => !SCENE_GLOBALS.includes(g) && !HOOK_GLOBALS.includes(g))) continue;
    if (ownsPasses && needs.some((g) => !PASS_GLOBALS.includes(g))) continue;
    const defs = [];
    const registry = { register: (def) => defs.push(def) };
    try {
      if (drawsLines) {
        // Registered with a stand-in GlowLines (its option lists only):
        // nothing is drawn while a file loads.
        const lines = { create: () => ({}), NATIVE_PALETTES: ['Rainbow', 'Neon', 'Ember'], BACKGROUNDS: ['Deep Space', 'Black', 'Nebula Glow', 'Ink on Paper'] };
        new Function('EffectRegistry', 'GlowLines', 'Controls', 'Renderer', 'AudioReactor', text)(registry, lines, {}, {}, undefined);
      } else if (accumulates) {
        // Registered with stand-ins and the real lab helpers: nothing is
        // drawn and no worker starts while a file loads.
        if (!FractalLab) continue;
        new Function('EffectRegistry', 'FractalLab', 'Controls', 'Renderer', 'ProgressiveDensityRenderer', 'PsyPalettes', text)(
          registry, FractalLab, {}, {}, undefined, undefined,
        );
      } else if (ownsPasses) {
        // Registered with stand-ins: nothing is drawn while a file loads.
        // make() gives the hooks the adapter's runner gives (shadertoy-
        // adapter.js), doing nothing, so a scene it hosts registers with a
        // render of its own and is judged by its file hash like the others.
        const runner = { lines: (parts) => parts.join('\n'), pass: () => null, make: () => STAND_IN_RUNNER };
        new Function('EffectRegistry', 'ShadertoyEffectRunner', 'ShadertoyPassGraph', 'GpuSim', 'Controls', 'Renderer', 'AudioReactor', 'PsyPalettes', text)(
          registry, runner, {}, {}, {}, {}, {}, undefined,
        );
      } else if (provides.includes('EndlessScenes')) {
        // endless-scenes.js registers through the EndlessScenes it defines.
        new Function('EffectRegistry', 'FractalFlight', text)(registry, FractalFlight);
      } else if (needs.includes('EndlessScenes')) {
        if (!EndlessScenes) continue;
        // EndlessScenes.register goes to the registry it was loaded with: a
        // fresh one on this registry. The scenes it registers on loading are
        // endless-scenes.js's own, not this file's.
        const fresh = new Function('EffectRegistry', 'FractalFlight', `${read('endless-scenes')}\nreturn EndlessScenes;`)(registry, FractalFlight);
        const own = defs.length;
        new Function('EffectRegistry', 'FractalFlight', 'EndlessScenes', text)(registry, FractalFlight, fresh);
        defs.splice(0, own);
      } else {
        new Function('EffectRegistry', 'FractalFlight', 'FractalLab', 'EndlessScenes', text)(registry, FractalFlight, FractalLab, EndlessScenes);
      }
    } catch (_) {
      continue;
    }
    if (defs.length) out.set(file.replace(/\.js$/, ''), defs);
  }
  return out;
}

/** Scene files in Psychedelia that need only SCENE_GLOBALS and draw with
 *  their own shader (no custom render): what ALL_SCENE_FILES is meant to
 *  hold. */
export function simpleSceneFiles(root) {
  const simple = [];
  for (const [name, defs] of sceneDefinitions(root)) {
    if (defs.some((def) => typeof def.render === 'function' || typeof def.shader !== 'string')) continue;
    simple.push(name);
  }
  return simple;
}

/** manifest.json `borrowed`: one row per scene (and per engine piece, scene
 *  '*') with borrowed code, from BORROWED and the scenes each imported file
 *  registers (`defsByFile`, sceneDefinitions). */
export function borrowedRows(defsByFile) {
  const rows = [];
  for (const piece of BORROWED) {
    for (const source of piece.files) {
      const name = source.replace(/^src\/(effects|engine)\//, '').replace(/\.js$/, '');
      const scenes = source.startsWith('src/engine/') ? ['*'] : (defsByFile.get(name) || []).map((def) => def.name);
      for (const scene of scenes) {
        rows.push({
          scene,
          file: source,
          piece: piece.id,
          author: piece.author,
          link: piece.link,
          ...(piece.linkNote ? { linkNote: piece.linkNote } : {}),
          licence: piece.licence,
          nonCommercial: Boolean(piece.nonCommercial),
          noLicenceStated: Boolean(piece.noLicenceStated),
        });
      }
    }
  }
  return rows;
}

export function readManifest() {
  return JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));
}

/** What changed upstream since the import (nothing is written):
 *  { same, changed: [{ source, target, upstream }], missing, notices,
 *  newScenes, goneScenes }. */
export function checkDrift(root, manifest = readManifest()) {
  const report = { same: 0, changed: [], missing: [], notices: [], newScenes: [], goneScenes: [], uncommitted: [] };
  const hashOf = (source) => {
    const path = join(root, ...source.split('/'));
    return existsSync(path) ? sha256(toLf(readFileSync(path, 'utf8'))) : null;
  };
  for (const entry of manifest.files) {
    const hash = hashOf(entry.source);
    if (hash === null) report.missing.push(entry.source);
    else if (hash === entry.sha256) report.same += 1;
    else report.changed.push({ source: entry.source, target: entry.target, upstream: upstreamOf(root, entry.source) });
  }
  for (const notice of manifest.notices) if (hashOf(notice.source) !== notice.sha256) report.notices.push(notice.source);
  // Listed originals with changes not committed upstream (null: git cannot say).
  report.uncommitted = uncommittedSources(root, [...manifest.files, ...manifest.notices].map((row) => row.source));
  const simple = simpleSceneFiles(root);
  report.newScenes = simple.filter((name) => !ALL_SCENE_FILES.includes(name));
  // Those that own their passes: each must still register a scene with a
  // render of its own (and need no more than PASS_GLOBALS).
  const defs = sceneDefinitions(root);
  const passing = PASS_FILES.filter((name) => (defs.get(name) || []).some((def) => typeof def.render === 'function'));
  report.goneScenes = ALL_SCENE_FILES.filter((name) => (PASS_FILES.includes(name) ? !passing.includes(name) : !simple.includes(name)));
  // The line-drawing scenes: each must still register a scene with a render
  // of its own (and need no more than LINE_GLOBALS).
  report.goneScenes.push(...LINE_FILES.filter((name) => !(defs.get(name) || []).some((def) => typeof def.render === 'function')));
  // The accumulating labs: the same (and need no more than ACCUMULATING_GLOBALS).
  report.goneScenes.push(...ACCUMULATING_FILES.filter((name) => !(defs.get(name) || []).some((def) => typeof def.render === 'function')));
  return report;
}

function emptyManifest() {
  return {
    generatedBy: 'scripts/import_psychedelia.mjs',
    origin: 'Psychedelia Studio',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 aivrar',
    hashes: 'SHA-256 of UTF-8 text with LF line endings; sha256 = the original file, bodySha256 = the text between the BEGIN and END lines',
    upstream: 'per file, when imported: the last Psychedelia commit that touched it, and whether it had uncommitted changes on top',
    files: [],
    notices: [],
  };
}

function findRoot(arg) {
  const root = resolve(arg || process.env.PSYCHEDELIA_ROOT || join(REPO, '..', 'psychedelia'));
  if (!existsSync(join(root, 'src', 'engine', 'shader-manager.js'))) {
    console.error(`Psychedelia not found at ${root}. Pass its folder as the first argument.`);
    process.exit(1);
  }
  return root;
}

function printDrift(root) {
  const report = checkDrift(root);
  console.log(`Psychedelia at ${root} (HEAD ${git(root, ['rev-parse', '--short', 'HEAD']) || 'unknown'})`);
  console.log(`unchanged since import: ${report.same} of ${report.same + report.changed.length + report.missing.length}`);
  for (const row of report.changed) {
    const up = row.upstream;
    const where = up
      ? `last commit ${(up.commit || '').slice(0, 7)} ${up.date || ''} "${up.subject || ''}"${up.uncommitted ? ', plus uncommitted changes' : ''}`
      : 'no git';
    console.log(`CHANGED  ${row.source}  (${where})`);
  }
  for (const source of report.missing) console.log(`MISSING  ${source}`);
  for (const source of report.notices) console.log(`NOTICE CHANGED  ${source}`);
  for (const name of report.newScenes) console.log(`NEW SCENE FILE, not imported  src/effects/${name}.js`);
  for (const name of report.goneScenes) console.log(`NO LONGER A SIMPLE SCENE  src/effects/${name}.js`);
  if (report.uncommitted === null) console.log('WARNING  git did not answer: cannot tell whether the originals are committed');
  for (const source of report.uncommitted || []) console.log(`WARNING  not committed upstream (an import would refuse it)  ${source}`);
  const count = report.changed.length + report.missing.length + report.notices.length
    + report.newScenes.length + report.goneScenes.length + (report.uncommitted ? report.uncommitted.length : 1);
  if (!count) console.log('no drift');
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith('--'));
  const root = findRoot(args.find((arg) => !arg.startsWith('--')));
  if (flags.includes('--check-drift')) {
    printDrift(root);
    return;
  }
  const onlyFlag = flags.find((flag) => flag.startsWith('--only='));
  const only = onlyFlag ? onlyFlag.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean) : null;
  const shortName = (file) => file.target.replace(/^effects\//, '').replace(/\.js$/, '');
  const chosen = only ? FILES.filter((file) => only.includes(file.source) || only.includes(shortName(file))) : FILES;
  if (only && chosen.length !== only.length) {
    console.error(`--only: not all of ${only.join(', ')} are imported files`);
    process.exit(1);
  }
  // The licence texts: with a whole import, or with --only and --notices.
  const withNotices = !only || flags.includes('--notices');
  // Every original this import reads, checked as committed before anything is written.
  let originals;
  try {
    originals = readOriginals(root, [...chosen.map((file) => file.source), ...(withNotices ? NOTICES.map((notice) => notice.source) : [])], {
      allowUncommitted: flags.includes('--allow-uncommitted'),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const globals = allGlobals(root);
  const manifest = only ? readManifest() : emptyManifest();
  manifest.upstream = emptyManifest().upstream;
  // A file this script no longer imports (a scene left out since) goes,
  // with its manifest entry.
  const imported = new Set(FILES.map((file) => file.target));
  for (const row of manifest.files.filter((old) => !imported.has(old.target))) {
    rmSync(join(VENDOR_DIR, ...row.target.split('/')), { force: true });
    console.log(`${row.target}: no longer imported, removed`);
  }
  manifest.files = manifest.files.filter((row) => imported.has(row.target));
  for (const file of chosen) {
    const original = originals.get(file.source);
    const { text, entry } = wrap({ source: file.source, original, globals });
    // Fails here, not in the app, if the file is not valid as strict code.
    new Function(toLf(text).replace('export default function load(G)', 'return function load(G)'));
    const out = join(VENDOR_DIR, ...file.target.split('/'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    const up = upstreamOf(root, file.source);
    const row = { target: file.target, ...entry };
    if (up) row.upstream = { commit: up.commit, date: up.date, uncommitted: up.uncommitted };
    const at = manifest.files.findIndex((old) => old.target === file.target);
    if (at >= 0) manifest.files[at] = row;
    else manifest.files.push(row);
    console.log(`${file.source} -> ${relative(REPO, out).split(sep).join('/')} (${entry.bytes} bytes, needs ${entry.needs.join(', ') || 'nothing'})`);
  }
  if (withNotices) {
    manifest.notices = [];
    for (const notice of NOTICES) {
      const text = toLf(originals.get(notice.source));
      writeFileSync(join(VENDOR_DIR, notice.target), text.replace(/\n/g, '\r\n'));
      manifest.notices.push({ target: notice.target, source: notice.source, sha256: sha256(text) });
    }
  }
  // Every scene with borrowed code (BORROWED), for the credits.
  manifest.borrowed = borrowedRows(sceneDefinitions(root));
  const order = (row) => FILES.findIndex((file) => file.target === row.target);
  manifest.files.sort((a, b) => order(a) - order(b));
  writeFileSync(join(VENDOR_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`.replace(/\n/g, '\r\n'));
  console.log(`manifest: ${manifest.files.length} files${only ? ` (${chosen.length} imported again)` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
