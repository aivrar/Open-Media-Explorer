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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
/** Every scene file imported (SCENE_FILES, then FLIGHT_FILES and ENDLESS_FILES). */
export const ALL_SCENE_FILES = Object.freeze([...SCENE_FILES, ...FLIGHT_FILES, ...ENDLESS_FILES]);
/** The helper files those need (no scenes of their own). */
export const HELPER_FILES = Object.freeze(['fractal-flight-common']);
/** The Psychedelia globals a scene file may need: the registry, the flight
 *  helpers, and EndlessScenes (from endless-scenes.js). */
export const SCENE_GLOBALS = Object.freeze(['EffectRegistry', 'FractalFlight', 'EndlessScenes']);

/** What the visualizer needs, in Psychedelia's own load order (index.html):
 *  the shader manager, the Beat Reactor (audio-signal.js must load before
 *  audio-reactor.js, which reads AudioSignal.bands as it loads), the post FX
 *  library (its shader passes only: Psychedelia's post-process.js needs its
 *  Renderer, so the app runs the passes itself, visualizer/fx-chain.js), the
 *  effect registry, the flight helpers, then the scenes.
 *
 *  palettes.js is not imported yet. Its licences are settled (Psychedelia's
 *  notices now carry the Matplotlib licence for Twilight and Cubehelix), but
 *  its palettes are look-up textures: the Palette Map pass needs one bound
 *  by the FX chain, and with it loaded the registry would add the library
 *  to every scene's palette select, whose extra entries need the texture
 *  bound on each draw. Neither is done by the app yet. Without it the
 *  library leaves out its Palette Map pass by itself (it checks for
 *  PsyPalettes) and the registry adds nothing. */
export const FILES = Object.freeze([
  { source: 'src/engine/shader-manager.js', target: 'engine/shader-manager.js' },
  { source: 'src/engine/audio-signal.js', target: 'engine/audio-signal.js' },
  { source: 'src/engine/audio-reactor.js', target: 'engine/audio-reactor.js' },
  { source: 'src/engine/post-fx-library.js', target: 'engine/post-fx-library.js' },
  // The Canvas 2D overlays (slice 6): loaded only when one is chosen, a fresh
  // instance per load (visualizer/overlay-layer.js), drawn into the app's own
  // canvas (PATCHES), with the Beat Reactor given through the flash gate.
  { source: 'src/engine/overlays.js', target: 'engine/overlays.js' },
  { source: 'src/effects/registry.js', target: 'effects/registry.js' },
  ...HELPER_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
  ...ALL_SCENE_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js` })),
]);

/** Code in the imported files that Psychedelia took from other people, as
 *  its THIRD_PARTY_NOTICES.md credits it (and a search of these files for
 *  credits, links and known routines). The app is free and makes no money,
 *  so borrowed code is ported with credit (the owner's decision, slice 7),
 *  whatever its licence; the licence is quoted as the source states it, or
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
    id: 'iq-palette', files: ['src/engine/shader-manager.js'],
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
    id: 'hoskins-hash', files: effects('endless-terrain', 'living-sun', 'nebula', 'endless-scenes', 'endless-sky-crystal'),
    piece: '"Hash without Sine", with adjusted constants',
    author: 'David Hoskins', link: 'https://www.shadertoy.com/view/4djSRW', licence: 'MIT License, Copyright (c)2014 David Hoskins',
  },
  {
    id: 'iq-distance-functions',
    files: effects('sierpinski', 'apollonian-foam-flight', 'difs-tunnel-flight', 'folded-box-variants-flight', 'kifs-flight', 'mandelbox-flight', 'path-traced-fractal-flight', 'polyfold-flight'),
    piece: 'distance functions sdBox, sdTorus, sdOctahedron (bound version) and the 2D box',
    author: IQ, link: 'https://iquilezles.org/articles/distfunctions/', licence: IQ_SNIPPETS,
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

/** The scenes each scene file in Psychedelia registers: Map(file name
 *  without .js -> [definition]), for the files that need only SCENE_GLOBALS
 *  and load (classic scripts run with a recording registry, the real flight
 *  helpers and, from endless-scenes.js, the real EndlessScenes). */
export function sceneDefinitions(root) {
  const globals = allGlobals(root);
  const dir = join(root, 'src', 'effects');
  const read = (name) => (existsSync(join(dir, `${name}.js`)) ? readFileSync(join(dir, `${name}.js`), 'utf8') : null);
  let FractalFlight;
  let EndlessScenes;
  try {
    const common = read('fractal-flight-common');
    if (common) FractalFlight = new Function(`${common}\nreturn FractalFlight;`)();
    const endless = read('endless-scenes');
    if (endless && FractalFlight) {
      EndlessScenes = new Function('EffectRegistry', 'FractalFlight', `${endless}\nreturn EndlessScenes;`)({ register() {} }, FractalFlight);
    }
  } catch (_) {}
  const out = new Map();
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.js')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    const provides = definedGlobals(text);
    const needs = globals.filter((g) => !provides.includes(g) && names(text, g));
    if (needs.some((g) => !SCENE_GLOBALS.includes(g))) continue;
    const defs = [];
    const registry = { register: (def) => defs.push(def) };
    try {
      if (provides.includes('EndlessScenes')) {
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
        new Function('EffectRegistry', 'FractalFlight', 'EndlessScenes', text)(registry, FractalFlight, EndlessScenes);
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
  report.goneScenes = ALL_SCENE_FILES.filter((name) => !simple.includes(name));
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
  // Every original this import reads, checked as committed before anything is written.
  let originals;
  try {
    originals = readOriginals(root, [...chosen.map((file) => file.source), ...(only ? [] : NOTICES.map((notice) => notice.source))], {
      allowUncommitted: flags.includes('--allow-uncommitted'),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const globals = allGlobals(root);
  const manifest = only ? readManifest() : emptyManifest();
  manifest.upstream = emptyManifest().upstream;
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
  if (!only) {
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
