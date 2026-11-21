/**
 * The Visualizer's scenes. Each is one Psychedelia scene file (vendored by
 * scripts/import_psychedelia.mjs) loaded with its own dynamic import, so the
 * bundler makes it a separate chunk and opening the tab fetches only the
 * scene being shown.
 *
 *   id        the name the scene registers under (and the saved setting)
 *   name      Psychedelia's label for it
 *   category  Psychedelia's category (the list is grouped by it)
 *   file      the vendored file (vendor/psychedelia/...)
 *   cost      how hard it works the graphics card, shown as a badge:
 *             'light'  a few dozen operations a pixel, no long loops
 *             'medium' loops of tens to a few hundred cheap steps, or layered
 *                      noise
 *             'heavy'  raymarching or volumetric loops (90-220 steps), or up
 *                      to 1000 fractal iterations
 *             The higher of the porting study's reading of each shader and the
 *             time a frame takes in software WebGL at 320 x 180
 *             (tests/helpers/visualizer-flash-check.*: under 15 ms light,
 *             60 ms and more heavy). The tab steps the quality and frame rate
 *             down by itself when a scene cannot keep up (step-down.js).
 *             The slice 7 flights and endless scenes are classed by that
 *             time alone (all raymarch, so the reading would make every one
 *             heavy; on the graphics card the five classed medium take 1 to
 *             4 ms at Medium): Infinite Lattice 32 ms, Planet Sunrise 55,
 *             Mandelbulb Flight 56, Menger Citadel 59, Recursive Cathedral
 *             59.5 (close to the line); KIFS Fold Flight 73 and the rest
 *             from 140 up, heavy. The slice 13 scenes by the slowest of
 *             their looks (a lab's preset compiles its own formula in):
 *             Cymatics 5 ms and Analytic Field Lab 12, light; Procedural
 *             Field Lab 29, medium; 2D Formula Lab 74 (its start look 34),
 *             Fractal Flame Lab 382 and Robot Foundry 291, heavy.
 *   audio     'shader': the scene reads u_audio / u_beat itself (no links);
 *             'links': it moves with the music through parameter links and
 *             the reactor's time surge; 'motion': only the time surge and the
 *             zoom punch (none of its params may carry a link: they are
 *             rates, light, or move a fractal dive in jumps)
 *   load      () => Promise of the module
 *   links     our own parameter links for a 'links' scene (Psychedelia's
 *             automatic suggestions are not used). Each must pass
 *             reactor.js linkRuleViolation: it moves size, shape or colour -
 *             never light - and no rate, no param that jumps the view (dive
 *             depth, target, iterations) and no param the shader multiplies
 *             by its clock (Psychedelia's own rule, so a change is a change of
 *             shape, not a jump through time). `amount` is the share of the
 *             param's range a full source pushes; kick pulses are capped at
 *             0.6 by the flash limiter and at most 3 a second. One link per
 *             param. Every scene also gets the limiter's zoom punch.
 *   mood, hue tags for the shuffle (TAGS below)
 *   drift     its slow drift where not the automatic one (SCENE_DRIFT)
 *   defaults  our own starting values for some params, in place of
 *             Psychedelia's (where its default looks wrong without its post
 *             pass and display chain, or is far too dark or bright: see the
 *             flash check); every other param keeps Psychedelia's.
 *
 * Most are drawn by one shader of their own (their files need the effect
 * registry, and the 3D flights and endless scenes also Psychedelia's flight
 * helpers); since slice 14 some own their passes (simulations and
 * frame-feedback scenes, `needs`: sim-host.js). Borrowed code is credited in
 * CREDITS.md and listed per scene in vendor/psychedelia/manifest.json
 * `borrowed`.
 */

import { simSupported } from './sim-host.js';
import { LINE_QUALITY_CAPS, OFFERED_LINE_SCENES } from './line-scenes.js';

// The line-drawing scenes (line-scenes.js): held out of SCENES until
// LINE_SCENES_RELEASED.
export { LINE_SCENE_ENTRIES, LINE_SCENES_RELEASED } from './line-scenes.js';
import { ACCUMULATING_QUALITY_CAPS, OFFERED_ACCUMULATING_SCENES } from './accumulating-scenes.js';
// The accumulating labs (accumulating-scenes.js): each held out of SCENES
// until it is in ACCUMULATING_RELEASED_IDS.
export { ACCUMULATING_RELEASED_IDS, ACCUMULATING_SCENE_ENTRIES } from './accumulating-scenes.js';
// World Media's own scenes (own-scenes.js): held out of SCENES until
// OWN_SCENES_RELEASED.
import { OFFERED_OWN_SCENES } from './own-scenes.js';
export { OWN_SCENE_ENTRIES, OWN_SCENES_RELEASED } from './own-scenes.js';

export const DEFAULT_SCENE = 'plasma';
export const COST_CLASSES = Object.freeze(['light', 'medium', 'heavy']);

const link = (param, source, amount) => Object.freeze({ param, source, amount });
const scene = (id, name, category, base, cost, audio, load, extra = {}) => ({
  id, name, category, file: `effects/${base}.js`, cost, audio, load, ...extra,
});

/** The endless scenes' engine (endless-scenes.js: EndlessScenes, and four
 *  scenes of its own). */
const loadEndless = () => import('./vendor/psychedelia/effects/endless-scenes.js');
/** endless-sky-crystal.js registers its three scenes through EndlessScenes:
 *  one module whose load(G) loads the engine on G's registry first (which
 *  also registers the engine's four) and hands it on. */
const loadSkyCrystal = () => Promise.all([
  loadEndless(),
  import('./vendor/psychedelia/effects/endless-sky-crystal.js'),
]).then(([engine, own]) => ({
  default: (G) => own.default({ ...G, EndlessScenes: engine.default(G).EndlessScenes }),
}));

/** Robot Foundry registers through EndlessScenes, as endless-sky-crystal.js
 *  does (slice 13). */
const loadRobotFoundry = () => Promise.all([
  loadEndless(),
  import('./vendor/psychedelia/effects/robot-foundry.js'),
]).then(([engine, own]) => ({
  default: (G) => own.default({ ...G, EndlessScenes: engine.default(G).EndlessScenes }),
}));

/** Slice 14: the simulations draw on Psychedelia's GpuSim (its toolkit for
 *  float targets, ping-pong pairs and programs), loaded with them; one
 *  instance per scene registered. */
const withGpuSim = (own) => () => Promise.all([
  import('./vendor/psychedelia/engine/gpu-sim.js'),
  own(),
]).then(([gpu, file]) => ({
  default: (G) => file.default({ ...G, GpuSim: gpu.default(G).GpuSim }),
}));
/** The frame-feedback scenes run on the app's small Shadertoy adapter
 *  (shadertoy-adapter.js) and Psychedelia's ShadertoyCompiler, loaded with
 *  them. */
const withShadertoy = (own) => () => Promise.all([
  import('./vendor/psychedelia/engine/shadertoy-compiler.js'),
  import('./shadertoy-adapter.js'),
  own(),
]).then(([compiler, adapter, file]) => ({
  default: (G) => file.default({
    ...G, ...adapter.createShadertoyAdapter({ ...G, ShadertoyCompiler: compiler.default({}).ShadertoyCompiler }),
  }),
}));

/** Tags for the shuffle (shuffle.js), set by judgement from what each scene
 *  is like: mood 'calm' (slow, drifting, contemplative) or 'lively' (busy,
 *  punchy, fast); hue 'warm', 'cool' or 'rainbow' (its colour family at
 *  its starting look). */
const TAGS = Object.freeze({
  plasma: ['lively', 'rainbow'], tunnel: ['lively', 'rainbow'], starfield: ['lively', 'cool'],
  metaballs: ['lively', 'rainbow'], voronoi: ['calm', 'rainbow'], synthwave: ['lively', 'warm'],
  truchet: ['calm', 'rainbow'], quasicrystal: ['calm', 'cool'], islamic_stars: ['calm', 'warm'],
  spiral_galaxy: ['calm', 'cool'], domain_colouring: ['calm', 'rainbow'], aurora: ['calm', 'cool'],
  black_hole: ['calm', 'warm'], burning_ship: ['calm', 'warm'], color_cycle: ['lively', 'rainbow'],
  domainwarp: ['calm', 'rainbow'], droste: ['lively', 'rainbow'], endless_terrain: ['calm', 'cool'],
  fire: ['lively', 'warm'], flowfield: ['calm', 'rainbow'], fbm: ['calm', 'cool'],
  fractal_flame: ['lively', 'warm'], glow_lab: ['lively', 'rainbow'], gyroid_tunnels: ['lively', 'cool'],
  hyperbolic_tiling: ['calm', 'cool'], julia: ['calm', 'rainbow'], kaleidoscope: ['lively', 'rainbow'],
  kleinian: ['calm', 'cool'], liquid_chrome: ['calm', 'cool'], liquid_light: ['lively', 'rainbow'],
  living_sun: ['lively', 'warm'], lyapunov: ['calm', 'warm'], mandelbrot_deep: ['calm', 'rainbow'],
  multibrot: ['calm', 'rainbow'], mandelbrot: ['calm', 'rainbow'], mandelbulb_slice: ['calm', 'warm'],
  moire: ['lively', 'cool'], nebula: ['calm', 'cool'], newton: ['calm', 'rainbow'],
  nova: ['calm', 'rainbow'], op_art: ['lively', 'cool'], orbit_trap: ['calm', 'rainbow'],
  perlin: ['calm', 'cool'], phoenix: ['calm', 'rainbow'], phyllotaxis: ['calm', 'warm'],
  polar_spiral: ['lively', 'rainbow'], rainy_window: ['calm', 'cool'], rotozoom: ['lively', 'rainbow'],
  seascape: ['calm', 'cool'], sierpinski: ['calm', 'rainbow'], sine_interference: ['lively', 'rainbow'],
  soap_bubbles: ['calm', 'rainbow'], swirl: ['lively', 'rainbow'], tricorn: ['calm', 'rainbow'],
  underwater: ['calm', 'cool'], water_ripple: ['calm', 'cool'], waves: ['lively', 'rainbow'],
  mandelbulb_flight: ['calm', 'warm'], triplex_mutation_flight: ['calm', 'rainbow'], kifs_flight: ['calm', 'cool'],
  difs_tunnel_flight: ['lively', 'cool'], mandelbox_flight: ['calm', 'rainbow'], folded_box_variants_flight: ['calm', 'cool'],
  quaternion_julia_flight: ['calm', 'warm'], hypercomplex_slice_flight: ['calm', 'cool'], schottky_inversion_flight: ['calm', 'rainbow'],
  apollonian_foam_flight: ['calm', 'cool'], polyfold_flight: ['calm', 'warm'], fractal_flame_volume_flight: ['calm', 'warm'],
  strange_attractor_flight: ['lively', 'rainbow'], lsystem_tube_flight: ['calm', 'warm'], path_traced_fractal_flight: ['calm', 'rainbow'],
  menger_citadel: ['calm', 'warm'], recursive_cathedral: ['calm', 'warm'], fractal_canyon: ['calm', 'warm'],
  infinite_lattice: ['calm', 'warm'], crystal_geode: ['calm', 'cool'], golden_hour_clouds: ['calm', 'warm'],
  planet_sunrise: ['calm', 'warm'], robot_foundry: ['lively', 'warm'], escape_time_lab: ['calm', 'rainbow'],
  analytic_field_lab: ['calm', 'rainbow'], procedural_field_lab: ['calm', 'rainbow'], fractal_flame_lab: ['lively', 'warm'],
  cymatics: ['calm', 'warm'],
  curl_silk: ['calm', 'cool'], fluid_ink: ['lively', 'rainbow'], lenia: ['calm', 'cool'], physarum: ['calm', 'warm'],
  feedback: ['lively', 'rainbow'], reaction_diffusion: ['calm', 'cool'],
});

/** The most the time surge may speed a scene up (the flash limiter's cap is
 *  3x): where its colours cycle or its dive runs on its clock, a faster clock
 *  is faster changes of light. Set from the flash check run with the surge
 *  held at its most (tests/helpers/visualizer-flash-check.mjs --worst): the
 *  highest cap of 3, 2, 1.5, 1.25 and 1 at which no frame-to-frame step
 *  of luminance reaches 0.10. */
export const SPEED_CAPS = Object.freeze({
  // Its palette cycles with its clock. At its own dive speed (120 s, surge at
  // its most, on the graphics card): 0.082 with no cap, 0.041 at most at 1.25
  // over its looks. Kept for that room under 0.10.
  mandelbrot: 1.25,
  // The curtains flare when the clock runs fast (in SwiftShader: 0.130 at 3x
  // and 2x, 0.034 at 1.5x).
  aurora: 1.5,
  // At its own dive target (120 s, surge at its most, on the graphics card):
  // 0.075 at 3x, 0.054 at 2x over its looks. Kept, as 2x stays under the
  // 0.06 at which the FX shuffle would have to hold its effects back
  // (FX_CALM_SCENES).
  tricorn: 2,
  // (Burning Ship's cap of 1.25 is gone: its Acid Smoke look stepped by 0.103
  // at 3x; since Psychedelia b4739fa it is 0.045, and 0.050 at most over all
  // its looks.)
  // Its camera rode the ground (0.22 a frame on its Midday look at 3x over
  // a 420-s check). Since Psychedelia b4739fa it glides over the ridges:
  // 0.062 at 3x on Midday (120 s), 0.033 at 1.5x, which keeps it clear of
  // the 0.06 at which the FX shuffle would have to hold its effects back
  // (FX_CALM_SCENES).
  endless_terrain: 1.5,
  // Slice 7, each over the same stretch of its clock as 120 s at 3x (so
  // 288 s at 1.25x, 360 s at 1x), over its looks. Mandelbulb Flight (0.026
  // at 3x), KIFS Fold Flight (0.030) and the endless scenes (0.034 at most)
  // need none.
  // Strange Attractor Flight, drawn as the tab draws it (around the
  // trajectory its setUniforms hook feeds, at Medium's size and caps; at
  // 3x Low and High step the same to 0.001), flies through its glowing
  // trajectory: its start look steps by 0.106 at 3x, 0.072 at 2x, 0.059 at
  // 1.5x; its Thomas Knot Orbit 0.102, 0.086, 0.076. 1.5x keeps both well
  // under 0.10; 0.06 or more, so calm (FX_CALM_SCENES). Its looks that step
  // over 0.10 even at 1x are left out (looks.js PRESETS_LEFT_OUT).
  strange_attractor_flight: 1.5,
  // Its Branch Grove Dive look steps by 0.103 at 3x, 0.065 at 1.5x, 0.054
  // at 1.25x; its Crystal Fern Cathedral (since Psychedelia 0a4fdc1) 0.062
  // at 1.25x, 0.056 at 1x: 1x keeps all its looks clear of the 0.06 of
  // FX_CALM_SCENES.
  lsystem_tube_flight: 1,
  // Held until Psychedelia 0a4fdc1 (its camera grazed the surface). Its
  // Ice Circuit look steps by 0.111 at 3x, 0.090 at 2x (180 s), 0.068 at 1x
  // (360 s): calm at any cap (FX_CALM_SCENES).
  polyfold_flight: 2,
  // Held until Psychedelia 0a4fdc1 (its camera cut into the volume, a level
  // change that stayed). Its first look steps by 0.129 at 3x, 0.086 at 2x
  // (180 s); its fourth 0.094 at 2x, 0.065 at 1x (360 s): calm at any cap.
  fractal_flame_volume_flight: 2,
  // Held until Psychedelia 0a4fdc1 (its camera passed through a sphere).
  // Its Pearl Void look steps by 0.108 at 3x (120 s), 0.072 at 2x (180 s), 0.055
  // at 1.5x (240 s), 0.038 at 1x: 1.5x keeps it clear of the 0.06 of
  // FX_CALM_SCENES.
  schottky_inversion_flight: 1.5,
  // Its fourth look beats at 3 Hz and more at 3x (0.12 peak to peak, steps
  // of 0.076); 0.060 at 2x, 0.052 at 1.5x with no oscillation.
  infinite_lattice: 1.5,
  // Slice 12, back from the held list, each checked at 1x over 360 s of its
  // clock (the stretch its old fault showed in), its failing looks left out
  // (looks.js PRESETS_LEFT_OUT). Apollonian Foam, Folded Box Variants and
  // Mandelbox fade into their background as the camera nears the surface
  // (scripts/import_psychedelia.mjs FLIGHT_CAMERA_NEAR); Triplex Mutation
  // and the Glass Fractal keep Psychedelia's own camera bubble. The most
  // over their offered looks: Apollonian Foam 0.084, Mandelbox 0.065,
  // Triplex Mutation 0.065, Folded Box Variants 0.044, Glass Fractal 0.041
  // (0.056 with its drift; the others have none, SCENE_DRIFT).
  apollonian_foam_flight: 1,
  folded_box_variants_flight: 1,
  mandelbox_flight: 1,
  triplex_mutation_flight: 1,
  path_traced_fractal_flight: 1,
  // Slice 13, over 360 s of its clock, the surge at its most: Analytic Field
  // Lab's start look (its Quasicrystal Wave, phase and colour on the clock)
  // steps by 0.108 at 3x, 0.102 at 2, 0.096 at 1.5 and 0.069 at 1; its
  // presets 0.044 at most at 3x.
  analytic_field_lab: 1,
  // Back from the held list on new start looks (their defaults), at 1x over
  // 360 s of their clock: DIFS Tunnel Flight 0.024, Quaternion Julia Flight
  // 0.075.
  difs_tunnel_flight: 1,
  quaternion_julia_flight: 1,
});

/** Scenes whose own frame-to-frame steps of light reach 0.06 with the
 *  surge held at its most, on the graphics card (the flash check with
 *  --worst --gpu): post effects could push them past 0.10, so the FX shuffle
 *  gives them only the effects that do not enlarge steps, and at most two
 *  (fx-catalog.js FX_LIVELY, FX_CALM_MAX). Fire too, though its own steps
 *  are small (0.026): since Psychedelia b9f21de its flame tongues flicker
 *  sharply at mid height, and Mirror folds that band over the whole picture
 *  (0.125 in the FX check, Mirror alone; 0.041 at most over its 56 runs
 *  with only calm effects). */
export const FX_CALM_SCENES = Object.freeze(new Set([
  'mandelbrot', 'burning_ship', 'glow_lab', 'nebula', 'sierpinski', 'plasma', 'aurora', 'fire',
  // Slice 7, back from the held list: 0.06 or more at every speed cap down to 1x.
  'polyfold_flight', 'fractal_flame_volume_flight',
  // 0.076 at its speed cap (SPEED_CAPS).
  'strange_attractor_flight',
  // 0.096 on one of its looks: no effects at all (FX_NONE_SCENES).
  'multibrot',
  // Slice 12, back from the held list: 0.06 or more at 1x (SPEED_CAPS).
  'apollonian_foam_flight', 'mandelbox_flight', 'triplex_mutation_flight',
  // Slice 13: 2D Formula Lab's Magnet Gate 0.076, Analytic Field Lab's start
  // look 0.069 at its cap of 1x.
  'escape_time_lab', 'analytic_field_lab',
  // Slice 14: Feedback Loop 0.062 (its trails zooming in on themselves).
  'feedback',
  // Back from the held list: Quaternion Julia Flight 0.075 at its cap of 1x.
  'quaternion_julia_flight',
]));
/** Calm scenes that get no effects at all (and overlays only plain on top):
 *  those whose own frame-to-frame steps reach 0.085 on some look they offer
 *  (no effects, no drift, the surge at its most under the scene's speed
 *  cap, on the graphics card), so no effect has room. The FX check over a
 *  whole drift cycle (51 s) put calm effects past 0.10 on Sierpinski
 *  (Halftone 0.127, Colour Grade 0.112).
 *  Their own steps, the most over their looks:
 *    Multibrot                  0.096
 *    Glow Lab                   0.096
 *    3D Fractal Flame Volume    0.094
 *    Sierpinski                 0.093
 *    Polyfold Flight            0.090 */
export const FX_NONE_SCENES = Object.freeze(new Set([
  'multibrot', 'glow_lab', 'fractal_flame_volume_flight', 'sierpinski', 'polyfold_flight',
]));

/** Effects a scene does not get (by effect id), on top of the calm
 *  rule: each one that the FX check, alone at the strong intensity, over a
 *  whole drift cycle (51 s, the surge at its most, on the graphics card),
 *  found stepping past 0.10 on it, or (two at once, as a calm scene may
 *  draw) close to it. */
const NO_FX_LEFT_OUT = Object.freeze([]);
export const FX_LEFT_OUT = Object.freeze({
  // Bloom: 0.108 without drift, 0.095 with it; Watercolour (beat flash on,
  // drift on): 0.107 (the scene alone 0.079). Its other calm effects that
  // raised its steps in 3-s clips stay under over the whole cycle: 0.086 at
  // most (Tilt-Shift).
  plasma: Object.freeze(['bloom', 'watercolour']),
  // Bloom: with Colour Grade (the two at once, strong, beat flash and drift
  // on, the whole cycle) 0.098, too near 0.10 (the scene alone 0.037; Colour
  // Grade with Halftone 0.088, Halftone with Bloom 0.069).
  nebula: Object.freeze(['bloom']),
  // Palette Map alone (slice 14, the colour index running there and back
  // along the palette), the whole cycle, three intensities: 0.094 on Aurora
  // (the scene alone 0.069), 0.087 on Sierpinski (0.055; it gets no
  // effects at all, FX_NONE_SCENES). Past the 0.085 margin; on the other
  // eight scenes checked 0.061 at most.
  aurora: Object.freeze(['palette_map']),
  sierpinski: Object.freeze(['palette_map']),
  // Voronoi Cells (not calm): Mirror in its Kaleidoscope mode, alone at the
  // strong intensity (10 segments), stepped by 0.102 in a 10-s clip (the
  // scene alone 0.014; on Starfield 0.022), with nothing else drawn.
  voronoi: Object.freeze(['mirror']),
});
// The other calm scenes (Nebula for its single effects), each with the calm effects that raised its steps in
// 3-s clips (or, where it had none, the ones that raised others' most), alone
// at the strong intensity, beat flash and drift on, over the whole cycle: none
// past 0.10. The most: Aurora 0.082 (Fisheye), Nebula 0.082 (Colour Grade),
// Burning Ship 0.046 (Halftone), Fire 0.042 (Zoom Blur), Mandelbrot 0.041
// (Bloom), Strange Attractor Flight 0.015 (Fisheye).

/** The most some params may be at each quality: the 3D flights' and endless
 *  scenes' own detail settings (orbit samples, iterations, branch quality,
 *  cloud steps) where lowering them saves graphics-card time. Applied as
 *  each frame is drawn (scene-renderer.js setQuality), from the quality
 *  drawn now (the step-down's), so a lower quality also lowers these; the
 *  scene's chosen values are not changed (looks, favourites and links see
 *  them as chosen). Measured on the test machine's graphics card at the
 *  tab's sizes in a 1920 x 1080 window (Low 1003 x 531, Medium 1504 x 797,
 *  High 2005 x 1063), ms a frame Low / Medium / High as Psychedelia has it,
 *  then with these caps:
 *    Strange Attractor Flight   detail 0.55 at every quality (52 steps
 *                               through its glow volume instead of 65); its
 *                               cost is mostly in pixels: SCENE_MAX_PIXELS
 *    L-System Tube Flight       16.9 / 35.7 / 62.1; 7.4 / 16.7 / 28.0
 *                               (quality 0.45, detail 0.7: the same branches
 *                               as at 0.65)
 *    Golden-Hour Clouds          9.9 / 17.9 / 30.4; 7.2 / 14.9 / 31.6 (High
 *                               uncapped)
 *    3D Fractal Flame Volume    12.5 / 26.3 / 45.4; 8.5 / 22.5 / 30.5 (High
 *                               with Low's caps: 37.3 with Medium's;
 *                               iterations 8 would reach 28.1 but darkens
 *                               the flame)
 *  The step-down (step-down.js) lowers the quality only below 80% of the
 *  frame rate asked for (24 at 30), so a scene at 33 to 41 ms a frame stays
 *  at High: the caps keep the two above near 28 ms there. Fractal Canyon
 *  (10.7 / 21.7 / 35.2, about 28 frames a second at High) is left as it is:
 *  its one cost setting, ray detail, saves little (29.1 ms at its least, 80)
 *  and below about 120 its far cliffs break into holes. At Low all hold 30
 *  fps with room (12 ms at most, 90th percentile), so the shuffle keeps them
 *  on Low too. Lowering the ray detail of the other flights saved nothing
 *  measurable (their rays end early); they keep their own. */
export const SCENE_QUALITY_CAPS = Object.freeze({
  // The simulations' own size (sim-host.js): particles, grid, agents.
  curl_silk: Object.freeze({
    low: Object.freeze({ particles: 0 }),
    medium: Object.freeze({ particles: 1 }),
    high: Object.freeze({ particles: 1 }),
  }),
  fluid_ink: Object.freeze({
    low: Object.freeze({ resolution: 0 }),
    medium: Object.freeze({ resolution: 1 }),
    high: Object.freeze({ resolution: 1 }),
  }),
  lenia: Object.freeze({
    low: Object.freeze({ resolution: 0 }),
    medium: Object.freeze({ resolution: 1 }),
    high: Object.freeze({ resolution: 1 }),
  }),
  physarum: Object.freeze({
    low: Object.freeze({ agents: 0, resolution: 0, steps: 1 }),
    medium: Object.freeze({ agents: 1, resolution: 0, steps: 1 }),
    high: Object.freeze({ agents: 1, resolution: 0, steps: 1 }),
  }),
  strange_attractor_flight: Object.freeze({
    low: Object.freeze({ detail: 0.55 }),
    medium: Object.freeze({ detail: 0.55 }),
    high: Object.freeze({ detail: 0.55 }),
  }),
  fractal_flame_volume_flight: Object.freeze({
    low: Object.freeze({ iterations: 9, detail: 0.6 }),
    medium: Object.freeze({ iterations: 9 }),
    high: Object.freeze({ iterations: 9, detail: 0.6 }),
  }),
  lsystem_tube_flight: Object.freeze({
    low: Object.freeze({ quality: 0.45, detail: 0.7 }),
    medium: Object.freeze({ quality: 0.45, detail: 0.7 }),
    high: Object.freeze({ quality: 0.45, detail: 0.7 }),
  }),
  golden_hour_clouds: Object.freeze({
    low: Object.freeze({ detail: 100 }),
    medium: Object.freeze({ detail: 100 }),
  }),
});

/** The most pixels a few scenes are drawn with at each quality, below the
 *  quality's own budget (visualizer-settings.js); the browser stretches the
 *  picture to the tab as it does at every quality. Strange Attractor Flight
 *  marches its glow volume around the whole 120-point trajectory its
 *  setUniforms hook feeds (u_attr_points: 120 segments at each of its 52
 *  steps; its orbit samples are then not used), about 72 ns a pixel on the
 *  test machine: 87 ms a frame at Medium's 1504 x 797 in a 1920 x 1080 window.
 *  Its picture is a soft glow that looks the same at 240 000 pixels
 *  stretched as at 1.2 million (compared 1:1). With these budgets, ms a
 *  frame (90th percentile) over its looks: Low 13 (14.6), Medium 20.7
 *  (22.3), High 24.2 (26.2): 30 frames a second with room at each. */
export const SCENE_MAX_PIXELS = Object.freeze({
  strange_attractor_flight: Object.freeze({ low: 150000, medium: 240000, high: 300000 }),
});

/** The most pixels scene `id` is drawn with at `quality`, or undefined (the
 *  quality's own budget). */
export function sceneMaxPixels(id, quality) {
  return SCENE_MAX_PIXELS[id]?.[quality];
}

/** The params of scene `id` with a quality cap at any quality (never
 *  drifted automatically: drift.js). */
export function sceneCappedParams(id) {
  const caps = SCENE_QUALITY_CAPS[id] || LINE_QUALITY_CAPS[id] || ACCUMULATING_QUALITY_CAPS[id];
  return caps ? [...new Set(Object.values(caps).flatMap((row) => Object.keys(row)))] : [];
}

/** Slow drift per scene (drift.js), where the automatic choice is not
 *  kept: false (no drift), or { depth (each way, a share of the range;
 *  drift.js DRIFT_DEPTH otherwise), exclude: [params], params: { param:
 *  depth } (these instead of the automatic choice) }. Set from the flash
 *  check run with drift at its deepest (the swell and the mood at their
 *  most, the drift clock at its fastest), on top of its worst case (the
 *  surge held at its most, the scene's speed cap), on the graphics card at
 *  752 x 398 with Medium's caps, every look: the scene's own over the same
 *  stretch of its clock as its speed cap, the others over two full drift
 *  cycles (tests/helpers/visualizer-flash-check.mjs --worst --looks --drift
 *  --clock-stretch=360 --looks-seconds=105). A calm scene (fxCalm) keeps
 *  its drift only where no look's largest step rises by more than 0.003.
 *  The entries from Plasma to Infinite Lattice were found with every wave at
 *  full depth and the clock at the track's 120 BPM, and are kept. */
export const SCENE_DRIFT = Object.freeze({
  // A calm scene (fxCalm). Its scale on the 4-bar wave: 0.104 at most, one
  // step over 0.10 (0.079 without drift); its saturation alone: 0.075.
  plasma: { exclude: ['scale'] },
  // A calm scene. Its zoom drifting: 0.120 at most, steps over 0.10 (0.096
  // without drift); without it: 0.094.
  glow_lab: { exclude: ['zoom'] },
  // Its zoom (its one param that drifts) at 0.10: 0.108 at most, steps over
  // 0.10 (0.055 without drift); at 0.05: 0.078.
  julia: { depth: 0.05 },
  // Its scale drifting: 0.110 at most over its looks, steps over 0.10 (0.044
  // without drift); without it: 0.068. Its thickness then: a 3.8 Hz
  // flicker of 0.100 peak to peak on its second look (0.053 without
  // drift); without both: 0.047.
  gyroid_tunnels: { exclude: ['scale', 'thickness'] },
  // Its power (its one param that drifts) between whole numbers moves the
  // set's cut across the picture: 0.111 at most at 0.10, steps over 0.10;
  // at 0.05 worse, 0.166 over its looks (0.096 without drift).
  multibrot: false,
  // Its angle on the 4-bar wave turns every seed at once: 0.102 at most, a
  // step over 0.10 (0.057 without drift); without it: 0.066.
  phyllotaxis: { exclude: ['angle_offset'] },
  // A calm scene: with its level shift drifting, 0.091 at most on its own
  // look (0.091 without), 0.095 on its fourth (0.093 without). Higher, so
  // none.
  sierpinski: false,
  // As Multibrot, its power (its one param that drifts): 0.131 at most,
  // a step over 0.10 (0.054 without drift).
  tricorn: false,
  // A calm scene. Its fold scale drifting: 0.042 at most (0.034 without
  // drift); without it: 0.030.
  polyfold_flight: { exclude: ['fold_scale'] },
  // One step reaches 0.106 without drift (a flare 40 s in); with drift,
  // 0.129 and steps over 0.10 in two stretches. None.
  strange_attractor_flight: false,
  // Its walls moving under the camera: 0.163 at most over its looks, 3.7
  // steps over 0.10 a second on its third (0.052 at most without drift);
  // without its iridescence, 0.188. None.
  infinite_lattice: false,
  // Its lacunarity (every octave's scale at once): 0.125 at most on its
  // fifth look, steps over 0.10 (0.044 without drift); without it: 0.048.
  fbm: { exclude: ['lacunarity'] },
  // Its slice through the set moves its cut across the picture: 0.117 at
  // most, steps over 0.10 on three looks; without it still 0.091 (its zoom),
  // against 0.051 at most over its looks without drift. None, so it keeps
  // its effects.
  mandelbulb_slice: false,
  // Its sphere gap on the 4-bar wave opens the spheres around the camera:
  // 0.233 at most, steps over 0.10 on every look; without it: 0.080.
  schottky_inversion_flight: { exclude: ['sphere_gap'] },
  // Slice 12, the flights back from the held list, at their cap of 1x over
  // 360 s of their clock. Their automatic drift (fold and foam shapes) moves
  // the surface past the camera: Apollonian Foam 0.094 (0.084 without),
  // Folded Box Variants 0.091 (0.044), Mandelbox 0.132 (0.065), Triplex
  // Mutation 0.210 (0.065), most over their offered looks. None. The Glass
  // Fractal keeps its drift: 0.056 (0.041 without).
  apollonian_foam_flight: false,
  folded_box_variants_flight: false,
  mandelbox_flight: false,
  triplex_mutation_flight: false,
  // Slice 13, over 360 s of their clock at their cap. Analytic Field Lab's
  // drift (scale, kaleidoscope, warp) moves its start look's bands across
  // the picture: 0.177 (0.069 without); without its scale still 0.156.
  // 2D Formula Lab's (its Julia point, the formula's motion) moves Lambda
  // Bloom's basins: 0.148 (0.030 without); without the Julia point still
  // 0.094, and Magnet Gate 0.082 (0.076). None for either. Cymatics 0.044
  // (0.037 without), Procedural Field Lab 0.039 (0.038), Fractal Flame Lab
  // 0.040 (0.023), Robot Foundry 0.015 (0.015) keep theirs.
  analytic_field_lab: false,
  escape_time_lab: false,
  // Slice 14. Lenia's drift (its growth centre and width) kills its
  // creatures: two of its three palettes then sat under 0.05 for about
  // 31 s at a time (none without). None.
  lenia: false,
  // Physarum's deposit drifting dims its trails: its first look then sat
  // under 0.05 for up to 11 s at a time (none without).
  physarum: { exclude: ['deposit'] },
  // Curl-Noise Silk's trail length on the fast wave: 0.062 at most (0.038
  // without drift), past the 0.06 of FX_CALM_SCENES.
  curl_silk: { exclude: ['trail'] },
  // Fluid Ink (stepping every other frame since slice 14's cost fix): with
  // its drift (stream size, swirl, motion) its darker colour schemes sat
  // under 0.05 for up to 5 s at a time (1.1 s without); with swirl and
  // motion only up to 7.8 s, without the stream size up to 19 s. None.
  fluid_ink: false,
  // Reaction-Diffusion's feed and kill rates drifting starve its pattern:
  // its third palette then sat under 0.05 for 109 s (none without). None.
  reaction_diffusion: false,
});

/** The caps for scene `id` at `quality` ({ param: most }), or null. */
export function sceneCaps(id, quality) {
  return SCENE_QUALITY_CAPS[id]?.[quality] || LINE_QUALITY_CAPS[id]?.[quality] || ACCUMULATING_QUALITY_CAPS[id]?.[quality] || null;
}

/** `values` with scene `id`'s caps at `quality` applied (a copy when one
 *  applies, else `values` itself). */
export function cappedValues(id, quality, values) {
  const caps = sceneCaps(id, quality);
  if (!caps || !values) return values;
  const out = { ...values };
  for (const [name, most] of Object.entries(caps)) {
    if (Number.isFinite(out[name]) && out[name] > most) out[name] = most;
  }
  return out;
}

/** Scenes ported but held out of the list, the shuffle and favourites until
 *  they are fixed (their files, credits and manifest rows stay, so
 *  bringing one back is a re-import, the flash check, and taking it off this
 *  list). A saved scene or favourite of a held scene is kept in the settings
 *  but not offered: the tab opens the default scene instead.
 *  The flights below fail the flash check at every speed cap down to 1x, on
 *  the graphics card at Medium (752 x 398), with the surge held at its most:
 *  their camera paths run into or through the fractal surface, so a frame or
 *  more is one flat colour (a pop of light). Where the camera goes depends on
 *  the scene's clock, not on how fast it runs, so each is checked over the
 *  same stretch of its clock as 120 s at 3x (360 s at 1x): a slower clock
 *  only reaches the same pop later. Reported upstream (camera clearance);
 *  the numbers are after its camera bubble (Psychedelia 0a4fdc1), which
 *  brought Polyfold, the Flame Volume and Schottky Inversion back. Slice 12
 *  brought back five more (SPEED_CAPS), and DIFS Tunnel and Quaternion
 *  Julia came back on new start looks (their defaults). The one below still
 *  fails with its start look, which cannot be left out (the most it may
 *  step by is 0.085, for room under 0.10): its distance estimate jumps from
 *  one frame to the next (the surface appears at the camera), so a fade by
 *  the camera's distance does not help; with its 4D shape held still (no
 *  slice motion, 4D rotation or morph of its constant) it still stepped by
 *  0.45 on its start look and 0.42 to 0.65 on its presets at 1x over 360 s. */
export const HELD_SCENES = Object.freeze({
  hypercomplex_slice_flight: 'the surface appears at the camera from one frame to the next: steps of 0.40 to 0.49 at 1x over 360 s on every look, its start look 0.43',
});

/** Every ported scene, held ones too (HELD_SCENES). */
const ALL_SCENES = Object.freeze([
  scene('plasma', 'Plasma', 'Demoscene', 'plasma', 'light', 'links', () => import('./vendor/psychedelia/effects/plasma.js'), {
    // pattern scale (a zoom of the plasma) on the kick; colour depth with the bass
    links: [link('scale', 'kick', 0.03), link('saturation', 'bass', 0.15)],
  }),
  scene('tunnel', 'Tunnel', 'Demoscene', 'tunnel', 'light', 'links', () => import('./vendor/psychedelia/effects/tunnel.js'), {
    // the tunnel's sway on the kick (speed, twist and colour shift are clock-scaled)
    links: [link('wobble', 'kick', 0.15)],
    // (Our rings 5 and brighter depth fade are Psychedelia's own defaults
    // since its commit 410e10c: no override, no import patch.)
  }),
  scene('starfield', 'Starfield', 'Demoscene', 'starfield', 'light', 'links', () => import('./vendor/psychedelia/effects/starfield.js'), {
    // streak length on the kick; star colour with the bass
    links: [link('trail_length', 'kick', 0.4), link('colorful', 'bass', 0.6)],
    // (Psychedelia's star glow is a compact core since its commit 410e10c:
    // its own star size 1.5 gives a dark sky with small stars, mean luminance
    // about 0.095, so our old size override 0.15 is gone.)
  }),
  scene('metaballs', 'Metaballs', 'Demoscene', 'metaballs', 'light', 'links', () => import('./vendor/psychedelia/effects/metaballs.js'), {
    // the balls swell on the kick
    links: [link('size', 'kick', 0.1)],
  }),
  scene('voronoi', 'Voronoi Cells', 'Math', 'voronoi', 'light', 'links', () => import('./vendor/psychedelia/effects/voronoi.js'), {
    // cell walls thicken on the kick; the cell grid scales with the bass
    links: [link('border_width', 'kick', 0.25), link('cell_count', 'bass', 0.08)],
  }),
  scene('synthwave', 'Synthwave Grid', 'Retro', 'synthwave-grid', 'light', 'links', () => import('./vendor/psychedelia/effects/synthwave-grid.js'), {
    // the mountains jump on the kick; the sun grows with the bass
    links: [link('mountains', 'kick', 0.2), link('sun_size', 'bass', 0.15)],
  }),
  scene('truchet', 'Truchet Tiles', 'Patterns', 'truchet-tiles', 'light', 'links', () => import('./vendor/psychedelia/effects/truchet-tiles.js'), {
    // the lines thicken on the kick; the tiling scales with the bass
    links: [link('width', 'kick', 0.12), link('tiles', 'bass', 0.04)],
  }),
  scene('quasicrystal', 'Quasicrystal', 'Patterns', 'quasicrystal', 'light', 'links', () => import('./vendor/psychedelia/effects/quasicrystal.js'), {
    // the interference pattern zooms on the kick (its contrast is light, so
    // it has no bass link)
    links: [link('frequency', 'kick', 0.02)],
  }),
  scene('islamic_stars', 'Islamic Star Patterns', 'Patterns', 'islamic-stars', 'light', 'shader', () => import('./vendor/psychedelia/effects/islamic-stars.js')),
  scene('spiral_galaxy', 'Spiral Galaxy', 'Cosmic', 'spiral-galaxy', 'light', 'shader', () => import('./vendor/psychedelia/effects/spiral-galaxy.js')),
  scene('domain_colouring', 'Complex Domain Coloring', 'Math', 'domain-colouring', 'light', 'shader', () => import('./vendor/psychedelia/effects/domain-colouring.js')),
  // Slice 3.
  scene('aurora', 'Aurora', 'Nature', 'aurora', 'medium', 'shader', () => import('./vendor/psychedelia/effects/aurora.js'), {
    // Its mids and kicks brighten the curtains (its own shader). On a real
    // graphics card at the window's size (the flash check with --gpu) its
    // default 1 made steps of 0.125 at an even 30 frames a second; 0.5 gives
    // 0.063 with the surge held at its most, leaving room for post effects.
    // SwiftShader draws its sin-hash noise differently (mean 0.09 there,
    // 0.25 on the card).
    defaults: { audio_react: 0.5 },
  }),
  scene('black_hole', 'Black Hole', 'Cosmic', 'black-hole', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/black-hole.js')),
  scene('burning_ship', 'Burning Ship', 'Fractals', 'burning-ship', 'medium', 'motion', () => import('./vendor/psychedelia/effects/burning-ship.js'), {
    // The Solar Ash palette (Psychedelia: Ember Hull), whose mean luminance
    // is about 0.27; every other palette leaves the default view at 0.02-0.04
    // (most of it is the ship's black inside).
    defaults: { palette_type: 5 },
  }),
  scene('color_cycle', 'Color Cycling', 'Color', 'color-cycle', 'light', 'motion', () => import('./vendor/psychedelia/effects/color-cycle.js')),
  scene('domainwarp', 'Domain Warp', 'Noise', 'domain-warp', 'medium', 'links', () => import('./vendor/psychedelia/effects/domain-warp.js'), {
    links: [link('scale', 'kick', 0.06), link('warp_strength', 'bass', 0.08)],
  }),
  scene('droste', 'Droste Effect', 'Distortion', 'droste', 'light', 'motion', () => import('./vendor/psychedelia/effects/droste.js')),
  // (Our altitude 1.4 is gone: since Psychedelia b4739fa its camera follows
  // the ground averaged along the path, with more clearance over taller
  // mountains; at its own altitude 1 the long check gives 0.033 at most, with
  // the speed cap, SPEED_CAPS.)
  scene('endless_terrain', 'Endless Terrain', 'Nature', 'endless-terrain', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/endless-terrain.js')),
  scene('fire', 'Fire', 'Demoscene', 'fire', 'light', 'motion', () => import('./vendor/psychedelia/effects/fire.js')),
  scene('flowfield', 'Flow Field', 'Noise', 'flow-field', 'medium', 'links', () => import('./vendor/psychedelia/effects/flow-field.js'), {
    links: [link('scale', 'kick', 0.05), link('color_spread', 'bass', 0.1)],
  }),
  scene('fbm', 'Fractal Brownian Motion', 'Noise', 'fractal-brownian', 'light', 'links', () => import('./vendor/psychedelia/effects/fractal-brownian.js'), {
    links: [link('scale', 'kick', 0.05)],
  }),
  scene('fractal_flame', 'Flame Variation Field', 'Fractals', 'fractal-flame', 'light', 'links', () => import('./vendor/psychedelia/effects/fractal-flame.js'), {
    links: [link('zoom', 'kick', 0.05), link('blend', 'bass', 0.15)],
  }),
  scene('glow_lab', 'Glow Lab', 'Psychedelic', 'glow-lab', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/glow-lab.js')),
  scene('gyroid_tunnels', 'Gyroid Tunnels', 'Geometry', 'gyroid-tunnels', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/gyroid-tunnels.js'), {
    // Its own beat reaction at half. Psychedelia b4739fa halved its kick glow;
    // at its own 1 the long check (120 s, surge at its most, on the card)
    // now gives up to 0.073 (Neon look), past the 0.06 at which the FX
    // shuffle would hold its effects back (FX_CALM_SCENES); 0.5 gives 0.044.
    defaults: { audio_react: 0.5 },
  }),
  scene('hyperbolic_tiling', 'Hyperbolic Tiling', 'Geometry', 'hyperbolic-tiling', 'medium', 'links', () => import('./vendor/psychedelia/effects/hyperbolic-tiling.js'), {
    links: [link('line_width', 'kick', 0.05)],
  }),
  scene('julia', 'Julia Set', 'Fractals', 'julia-set', 'medium', 'links', () => import('./vendor/psychedelia/effects/julia-set.js'), {
    links: [link('zoom', 'kick', 0.04)],
  }),
  scene('kaleidoscope', 'Kaleidoscope', 'Distortion', 'kaleidoscope', 'medium', 'links', () => import('./vendor/psychedelia/effects/kaleidoscope.js'), {
    links: [link('zoom', 'kick', 0.05), link('vividness', 'bass', 0.15)],
  }),
  scene('kleinian', 'Kleinian Group', 'Fractals', 'kleinian', 'heavy', 'links', () => import('./vendor/psychedelia/effects/kleinian.js'), {
    links: [link('zoom', 'kick', 0.03)],
  }),
  scene('liquid_chrome', 'Liquid Chrome', 'Geometry', 'liquid-chrome', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/liquid-chrome.js')),
  scene('liquid_light', 'Liquid Light Show', 'Psychedelic', 'liquid-light', 'medium', 'links', () => import('./vendor/psychedelia/effects/liquid-light.js'), {
    links: [link('scale', 'kick', 0.06), link('saturation', 'bass', 0.2)],
  }),
  scene('living_sun', 'Living Sun', 'Cosmic', 'living-sun', 'medium', 'shader', () => import('./vendor/psychedelia/effects/living-sun.js'), {
    // Kicks fire the corona (x (1 + 1.5 kick)): steps of up to 0.096 at a
    // beat reaction of 1, under 0.06 at 0.5.
    defaults: { audio_react: 0.5 },
  }),
  scene('lyapunov', 'Lyapunov Fractal', 'Fractals', 'lyapunov-fractal', 'heavy', 'links', () => import('./vendor/psychedelia/effects/lyapunov-fractal.js'), {
    links: [link('zoom', 'kick', 0.015)],
  }),
  // Motion only: dive depth and target jump, the rest are rates or light (its
  // stripe density shows only in the Stripe colouring, not by default).
  scene('mandelbrot_deep', 'Mandelbrot Deep', 'Fractals', 'mandelbrot-deep', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/mandelbrot-deep.js')),
  scene('multibrot', 'Multibrot', 'Fractals', 'mandelbrot-power', 'heavy', 'links', () => import('./vendor/psychedelia/effects/mandelbrot-power.js'), {
    links: [link('power', 'kick', 0.02)],
  }),
  // (Our slower dive, 0.5, is gone: Psychedelia's own 0.75 steps by 0.041 at
  // most over its looks since its b4739fa, with the speed cap.)
  scene('mandelbrot', 'Mandelbrot', 'Fractals', 'mandelbrot', 'medium', 'motion', () => import('./vendor/psychedelia/effects/mandelbrot.js')),
  scene('mandelbulb_slice', 'Mandelbulb Slice', 'Fractals', 'mandelbulb-slice', 'medium', 'links', () => import('./vendor/psychedelia/effects/mandelbulb-slice.js'), {
    links: [link('zoom', 'kick', 0.04), link('power', 'bass', 0.08)],
  }),
  scene('moire', 'Moire Patterns', 'Demoscene', 'moire', 'light', 'links', () => import('./vendor/psychedelia/effects/moire.js'), {
    links: [link('ring_width', 'kick', 0.016)],
  }),
  scene('nebula', 'Nebula Flythrough', 'Cosmic', 'nebula', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/nebula.js'), {
    // Its shader brightens the gas on every kick (glow x (1 + 0.4 kick) since
    // Psychedelia b4739fa, which halved it) and sways with the beat. At its
    // own beat reaction of 1 the long check (120 s, its looks too, surge at
    // its most, on the card) still steps by 0.16-0.17 a frame, at 0.5 by up
    // to 0.103; 0.25 gives 0.061 at most.
    defaults: { audio_react: 0.25 },
  }),
  scene('newton', 'Newton Fractal', 'Fractals', 'newton-fractal', 'medium', 'links', () => import('./vendor/psychedelia/effects/newton-fractal.js'), {
    links: [link('zoom', 'kick', 0.04), link('distort', 'bass', 0.08)],
  }),
  scene('nova', 'Nova Fractal', 'Fractals', 'nova-fractal', 'medium', 'links', () => import('./vendor/psychedelia/effects/nova-fractal.js'), {
    links: [link('zoom', 'kick', 0.04)],
  }),
  scene('op_art', 'Op Art', 'Patterns', 'op-art', 'light', 'links', () => import('./vendor/psychedelia/effects/op-art.js'), {
    links: [link('amplitude', 'kick', 0.05)],
  }),
  scene('orbit_trap', 'Orbit Trap', 'Fractals', 'orbit-trap', 'heavy', 'links', () => import('./vendor/psychedelia/effects/orbit-trap.js'), {
    links: [link('trap_size', 'kick', 0.04)],
  }),
  scene('perlin', 'Perlin Noise', 'Noise', 'perlin-noise', 'light', 'links', () => import('./vendor/psychedelia/effects/perlin-noise.js'), {
    links: [link('scale', 'kick', 0.04)],
  }),
  scene('phoenix', 'Phoenix Fractal', 'Fractals', 'phoenix-fractal', 'medium', 'links', () => import('./vendor/psychedelia/effects/phoenix-fractal.js'), {
    links: [link('zoom', 'kick', 0.04)],
  }),
  scene('phyllotaxis', 'Phyllotaxis', 'Math', 'phyllotaxis', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/phyllotaxis.js')),
  scene('polar_spiral', 'Polar Spiral', 'Math', 'polar-spiral', 'light', 'links', () => import('./vendor/psychedelia/effects/polar-spiral.js'), {
    links: [link('twist', 'kick', 0.04), link('zoom', 'bass', 0.1)],
  }),
  scene('rainy_window', 'Rainy Window', 'Nature', 'rainy-window', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/rainy-window.js'), {
    // No lightning (Psychedelia: 0.2): it is a flash by design, at random and
    // on snares.
    defaults: { lightning: 0 },
  }),
  scene('rotozoom', 'Rotozoom', 'Demoscene', 'rotozoom', 'light', 'links', () => import('./vendor/psychedelia/effects/rotozoom.js'), {
    links: [link('scale', 'kick', 0.05)],
  }),
  scene('seascape', 'Seascape', 'Nature', 'seascape', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/seascape.js')),
  scene('sierpinski', 'Sierpinski', 'Fractals', 'sierpinski', 'light', 'links', () => import('./vendor/psychedelia/effects/sierpinski.js'), {
    links: [link('level_shift', 'bass', 0.1)],
    // Slower colour cycling (Psychedelia: 0.5): steps of light on the card
    // 0.090 -> 0.072 at 752 x 398 and 0.069 -> 0.055 at 1504 x 797.
    defaults: { color_speed: 0.3 },
  }),
  scene('sine_interference', 'Sine Interference', 'Math', 'sine-interference', 'light', 'links', () => import('./vendor/psychedelia/effects/sine-interference.js'), {
    links: [link('frequency', 'kick', 0.025)],
  }),
  scene('soap_bubbles', 'Soap Bubbles', 'Psychedelic', 'soap-bubbles', 'medium', 'shader', () => import('./vendor/psychedelia/effects/soap-bubbles.js')),
  scene('swirl', 'Swirl Vortex', 'Distortion', 'swirl', 'light', 'links', () => import('./vendor/psychedelia/effects/swirl.js'), {
    links: [link('twist', 'kick', 0.05), link('radius', 'bass', 0.1)],
  }),
  // No link: the power on the kick (0.02) stepped by up to 0.120 over a
  // 120-s dive (the long check, surge at its most), in 4-5 windows of 12;
  // 0.01 stayed under 0.070 but moves the shape by under 2.5%, too little to
  // see. It moves with the music through its dive speed, as Mandelbrot does.
  // (Our dive target -0.4 is gone: diving to Psychedelia's -1.0 stepped by
  // up to 0.119; since its b4739fa, 0.054 at most over its looks at the cap
  // of 2.)
  scene('tricorn', 'Tricorn', 'Fractals', 'tricorn', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/tricorn.js')),
  scene('underwater', 'Underwater', 'Nature', 'underwater', 'medium', 'shader', () => import('./vendor/psychedelia/effects/underwater.js')),
  scene('water_ripple', 'Water Ripple', 'Demoscene', 'water-ripple', 'light', 'links', () => import('./vendor/psychedelia/effects/water-ripple.js'), {
    links: [link('refraction', 'kick', 0.1)],
  }),
  scene('waves', 'Wave Distortion', 'Distortion', 'wave-distort', 'light', 'links', () => import('./vendor/psychedelia/effects/wave-distort.js'), {
    links: [link('amplitude', 'kick', 0.04), link('frequency', 'bass', 0.08)],
  }),
  // Slice 7: the 3D fractal flights (each one raymarched shader, its mode
  // compiled in) and the endless scenes. The flights read no sound
  // themselves; they move with the music through the time surge only (their
  // params are fold shapes, iteration counts and camera rates: a change of
  // any of them moves the whole view at once).
  scene('mandelbulb_flight', 'Mandelbulb Flight', 'Fractals', 'mandelbulb-flight', 'medium', 'motion', () => import('./vendor/psychedelia/effects/mandelbulb-flight.js')),
  scene('triplex_mutation_flight', 'Triplex Mutation Flight', 'Fractals', 'triplex-mutation-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/triplex-mutation-flight.js')),
  scene('kifs_flight', 'KIFS Fold Flight', 'Fractals', 'kifs-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/kifs-flight.js')),
  scene('difs_tunnel_flight', 'DIFS Tunnel Flight', 'Fractals', 'difs-tunnel-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/difs-tunnel-flight.js'), {
    // It starts on its Koch Vault Orbit preset: its own start look stepped
    // by 0.092 at 1x over 360 s of its clock (its surface appearing at the
    // camera), Koch Vault Orbit by 0.024 (0.0244 again as its start look,
    // the surge at its most under its cap of 1x, never under 0.05; its
    // other presets are left out, looks.js PRESETS_LEFT_OUT).
    defaults: {
      family: 0, iterations: 9, fold_scale: 2.72, fold_offset: 0.86, fold_bias: 0.12, symmetry: 6, twist: 0.62, thickness: 0.76, bailout: 4.2,
      detail: 1.2, flight_speed: 1.55, tunnel_depth: 1.25, orbit_radius: 1.18, orbit_spin: 1.28, motion_mode: 0, motion_phase: 0.14,
      structure_pulse: 0.66, fold_rotation: 0.66, roll: 0.22, roll_speed: 1.2, color_speed: 0.72, palette: 0, shade_mode: 2, fog: 0.24, glow: 1.78,
    },
  }),
  scene('mandelbox_flight', 'Mandelbox Flight', 'Fractals', 'mandelbox-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/mandelbox-flight.js')),
  scene('folded_box_variants_flight', 'Folded Box Variants Flight', 'Fractals', 'folded-box-variants-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/folded-box-variants-flight.js')),
  scene('quaternion_julia_flight', 'Quaternion Julia Flight', 'Fractals', 'quaternion-julia-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/quaternion-julia-flight.js'), {
    // It starts on its Amber Glass colours: its own Alien Coral stepped by
    // 0.099 at 1x over 360 s of its clock, Amber Glass by 0.075 (0.0747
    // again as its start look under its cap of 1x, never under 0.05: calm,
    // FX_CALM_SCENES; its other colours are left out, looks.js
    // LOOKS_LEFT_OUT).
    defaults: { palette: 1 },
  }),
  scene('hypercomplex_slice_flight', 'Hypercomplex Slice Flight', 'Fractals', 'hypercomplex-slice-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/hypercomplex-slice-flight.js')),
  scene('schottky_inversion_flight', 'Schottky Inversion Flight', 'Fractals', 'schottky-inversion-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/schottky-inversion-flight.js')),
  // Borrowed code under CC BY-NC-SA 3.0 and code with no licence stated
  // (CREDITS.md; manifest.json `borrowed`).
  scene('apollonian_foam_flight', 'Apollonian Foam Flight', 'Fractals', 'apollonian-foam-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/apollonian-foam-flight.js')),
  scene('polyfold_flight', 'Polyfold Flight', 'Fractals', 'polyfold-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/polyfold-flight.js')),
  scene('fractal_flame_volume_flight', '3D Fractal Flame Volume Flight', 'Fractals', 'fractal-flame-volume-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/fractal-flame-volume-flight.js'), {
    // It starts on its Spherical Bloom Cloud preset: its own start look sat
    // under 0.05 for 6.7 s at a time (the near-black sweep, 30 s at Medium
    // on the graphics card; 6.5 s with more glow), Spherical Bloom Cloud
    // never (mean 0.285).
    defaults: {
      flame_mode: 1, iterations: 14, affine_scale: 1.18, swirl_strength: 0.82, spherical_warp: 1.24, density: 1.48, detail: 1.3,
      flight_speed: 2.24, flight_depth: 1.58, orbit_radius: 1.28, orbit_spin: 1.58, motion_mode: 0, motion_phase: 0.28,
      transform_morph: 0.94, volume_twist: 0.74, color_bleed: 0.82, roll: 0.3, roll_speed: 1.48, fov: 1.04, color_speed: 0.84,
      palette: 1, shade_mode: 3, fog: 0.24, glow: 1.94,
    },
  }),
  scene('strange_attractor_flight', 'Strange Attractor Flight', 'Fractals', 'strange-attractor-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/strange-attractor-flight.js')),
  scene('lsystem_tube_flight', 'L-System Tube Flight', 'Fractals', 'lsystem-tube-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/lsystem-tube-flight.js')),
  scene('path_traced_fractal_flight', 'Glass Fractal DE Flight', 'Fractals', 'path-traced-fractal-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/path-traced-fractal-flight.js')),
  // The endless scenes: four in endless-scenes.js, three more in
  // endless-sky-crystal.js on top of its engine. Their sound changes light
  // only (their own shader).
  scene('menger_citadel', 'Menger Citadel', 'Endless Scenes', 'endless-scenes', 'medium', 'shader', loadEndless),
  scene('recursive_cathedral', 'Recursive Cathedral', 'Endless Scenes', 'endless-scenes', 'medium', 'shader', loadEndless),
  scene('fractal_canyon', 'Fractal Canyon', 'Endless Scenes', 'endless-scenes', 'heavy', 'shader', loadEndless),
  scene('infinite_lattice', 'Infinite Lattice', 'Endless Scenes', 'endless-scenes', 'medium', 'shader', loadEndless),
  scene('crystal_geode', 'Crystal Geode', 'Endless Scenes', 'endless-sky-crystal', 'heavy', 'shader', loadSkyCrystal),
  scene('golden_hour_clouds', 'Golden-Hour Clouds', 'Endless Scenes', 'endless-sky-crystal', 'heavy', 'shader', loadSkyCrystal),
  scene('planet_sunrise', 'Planet Sunrise', 'Endless Scenes', 'endless-sky-crystal', 'medium', 'shader', loadSkyCrystal),
  // Slice 13: one more endless scene, Psychedelia's four Fractal Labs (each
  // one shader, its formula mode compiled in; they read no sound and move
  // with the music through the time surge) and Cymatics, whose hook picks
  // the plate's pattern from the strongest pitch the Beat Reactor hears.
  scene('robot_foundry', 'Robot Foundry', 'Endless Scenes', 'robot-foundry', 'heavy', 'shader', loadRobotFoundry),
  scene('escape_time_lab', '2D Formula Lab', 'Fractals', 'escape-time-lab', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/escape-time-lab.js')),
  scene('analytic_field_lab', 'Analytic Field Lab', 'Fractals', 'analytic-field-lab', 'light', 'motion', () => import('./vendor/psychedelia/effects/analytic-field-lab.js')),
  scene('procedural_field_lab', 'Procedural Field Lab', 'Fractals', 'procedural-field-lab', 'medium', 'motion', () => import('./vendor/psychedelia/effects/procedural-field-lab.js')),
  scene('fractal_flame_lab', 'Fractal Flame Lab', 'Fractals', 'fractal-flame-lab', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/fractal-flame-lab.js')),
  scene('cymatics', 'Cymatics', 'Math', 'cymatics', 'light', 'shader', () => import('./vendor/psychedelia/effects/cymatics.js')),
  // Slice 14: scenes that own their passes (sim-host.js), each with the
  // render targets it needs (`needs`: 'float' for float targets, 'half'
  // for half floats at least, 'webgl2' for 8-bit ones); where the context
  // cannot make them they are not offered. They read the beat sources
  // themselves ('shader').
  scene('curl_silk', 'Curl-Noise Silk', 'Simulation', 'curl-silk', 'heavy', 'shader', withGpuSim(() => import('./vendor/psychedelia/effects/curl-silk.js')), {
    needs: 'float',
    // At its own brightness (1) it sat under 0.05 for up to 38 s at a time.
    defaults: { brightness: 2.6 },
  }),
  scene('fluid_ink', 'Fluid Ink', 'Simulation', 'fluid-ink', 'heavy', 'shader', withGpuSim(() => import('./vendor/psychedelia/effects/fluid-ink.js')), {
    needs: 'float',
    // Its first look's brightness (looks.js LOOK_ADJUSTED).
    defaults: { brightness: 1.6 },
  }),
  scene('lenia', 'Lenia', 'Simulation', 'lenia', 'heavy', 'shader', withGpuSim(() => import('./vendor/psychedelia/effects/lenia.js')), {
    needs: 'float',
    // Its own SmoothLife rule dies out to near black in about 100 s with
    // two of its three palettes; the Lenia ring rule keeps living.
    defaults: { rule: 1 },
  }),
  scene('physarum', 'Physarum', 'Simulation', 'physarum', 'heavy', 'shader', () => import('./vendor/psychedelia/effects/physarum.js'), { needs: 'float' }),
  scene('feedback', 'Feedback Loop', 'Distortion', 'feedback-loop', 'heavy', 'motion', withShadertoy(() => import('./vendor/psychedelia/effects/feedback-loop.js')), { needs: 'webgl2' }),
  scene('reaction_diffusion', 'Reaction-Diffusion', 'Simulation', 'reaction-diffusion', 'heavy', 'motion', withShadertoy(() => import('./vendor/psychedelia/effects/reaction-diffusion.js')), { needs: 'half' }),
].map((entry) => Object.freeze({
  ...entry,
  mood: TAGS[entry.id][0],
  hue: TAGS[entry.id][1],
  ...(SPEED_CAPS[entry.id] ? { maxSpeed: SPEED_CAPS[entry.id] } : {}),
  fxCalm: FX_CALM_SCENES.has(entry.id),
  fxNone: FX_NONE_SCENES.has(entry.id),
  fxLeftOut: FX_LEFT_OUT[entry.id] || NO_FX_LEFT_OUT,
  ...(Object.hasOwn(SCENE_DRIFT, entry.id) ? { drift: SCENE_DRIFT[entry.id] } : {}),
  links: entry.links ? Object.freeze(entry.links) : null,
  defaults: entry.defaults ? Object.freeze(entry.defaults) : null,
})));

/** The scenes offered: every ported scene but the held ones (and the
 *  line-drawing scenes, the accumulating labs and World Media's own scenes
 *  once released, line-scenes.js, accumulating-scenes.js, own-scenes.js). */
export const SCENES = Object.freeze([
  ...ALL_SCENES.filter((entry) => !Object.hasOwn(HELD_SCENES, entry.id)), ...OFFERED_LINE_SCENES, ...OFFERED_ACCUMULATING_SCENES,
  ...OFFERED_OWN_SCENES,
]);
/** The cost class of offered scene `id` ('light' | 'medium' | 'heavy'), or
 *  null (lib/tuner-background.js draws only light ones). */
export function sceneCost(id) {
  return SCENES.find((entry) => entry.id === id)?.cost || null;
}
/** The held scenes' entries (for the flash check and the tests; never offered). */
export const HELD_SCENE_ENTRIES = Object.freeze(ALL_SCENES.filter((entry) => Object.hasOwn(HELD_SCENES, entry.id)));

/** The scenes as the list shows them: by category, then by name. Previous
 *  and next follow this order. */
/** Scenes that own their passes (`needs` set: sim-host.js). */
export function ownsPasses(entry) {
  return Boolean(entry?.needs);
}

/** `scenes` less those that need render targets the context cannot make
 *  (`support`: sim-host.js simSupport). */
export function drawableScenes(scenes, support) {
  return scenes.filter((entry) => !entry.needs || simSupported(entry.needs, support));
}

/** Steps a second for a frame-feedback scene (its `simRate`), or null. */
export function sceneSimRate(id) {
  return sceneById(id)?.simRate ?? null;
}

export function orderedScenes(scenes = SCENES) {
  return [...scenes].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
}

export function sceneById(id) {
  return SCENES.find((entry) => entry.id === id) || null;
}

/** The scene `step` places after `id` in `scenes` (wrapping round). */
export function stepScene(id, step, scenes = SCENES) {
  if (!scenes.length) return null;
  const at = scenes.findIndex((entry) => entry.id === id);
  const from = at < 0 ? 0 : at;
  const next = (((from + step) % scenes.length) + scenes.length) % scenes.length;
  return scenes[next].id;
}
