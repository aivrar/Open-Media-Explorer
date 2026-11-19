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
 *             from 140 up, heavy.
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
 *   defaults  our own starting values for some params, in place of
 *             Psychedelia's (where its default looks wrong without its post
 *             pass and display chain, or is far too dark or bright: see the
 *             flash check); every other param keeps Psychedelia's.
 *
 * Only scenes drawn by one shader of their own are here (their files need
 * the effect registry, and the 3D flights and endless scenes also
 * Psychedelia's flight helpers). Borrowed code is credited in CREDITS.md and
 * listed per scene in vendor/psychedelia/manifest.json `borrowed`.
 */

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
  planet_sunrise: ['calm', 'warm'],
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
  // at 3x), KIFS Fold Flight (0.030), the endless scenes (0.034 at most) and
  // Strange Attractor Flight (0.017, drawn as the tab draws it: around the
  // trajectory its setUniforms hook feeds; its Aizawa Bloom Tunnel, left
  // out in looks.js PRESETS_LEFT_OUT, still drops by 0.37) need none.
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
]));
/** Calm scenes that get no shuffled effects at all (and overlays only plain
 *  on top): none now. Mandelbrot was one until Psychedelia b4739fa stopped
 *  its inside changing colour as its dive deepened. The FX check on it as a
 *  calm scene (135 runs of the calm effects, at most two, over the three
 *  intensities, flash on and off, and Shockwave): 0.023 at most, against
 *  0.045 on Burning Ship and 0.099 on Plasma in the same check; overlays as
 *  the calm rule draws them on it: 0.079 at most (Bokeh, Screen). */
export const FX_NONE_SCENES = Object.freeze(new Set());

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

/** The caps for scene `id` at `quality` ({ param: most }), or null. */
export function sceneCaps(id, quality) {
  return SCENE_QUALITY_CAPS[id]?.[quality] || null;
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
 *  Psychedelia fixes them (their files, credits and manifest rows stay, so
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
 *  brought Polyfold, the Flame Volume and Schottky Inversion back. */
export const HELD_SCENES = Object.freeze({
  apollonian_foam_flight: 'camera passes through the surface: step 0.53 at 1x over 360 s on Sphere Chain Glide (0.20 to 0.53 on all six looks)',
  hypercomplex_slice_flight: 'camera passes through the surface: step 0.63 at 1x over 360 s on Tricomplex Ribbon Gate (0.39 to 0.63 on all five looks)',
  difs_tunnel_flight: 'camera passes through the surface: step 0.41 at 1x over 360 s on Mandalay Deep Box (Torus Tube Push 0.16, Kaleido Column Graze 0.13; the other two pass)',
  mandelbox_flight: 'camera passes through the surface: step 0.116 at 1x over 360 s on Cyan Circuit, once (t 195 s; its other three looks 0.095 at most)',
  path_traced_fractal_flight: 'camera passes through the surface: step 0.35 at 1x over 360 s on Void Caustic Shell Orbit (0.17 to 0.21 on three more; Default passes)',
  triplex_mutation_flight: 'camera passes through the surface: step 0.53 at 1x over 360 s on Burning Tunnel Push (Spudsville Fold Dive 0.29; the other three pass)',
  folded_box_variants_flight: 'camera passes through the surface: step 0.41 at 1x over 360 s on Smooth Mandelbox Drift (0.26 to 0.37 on three more; two pass)',
  quaternion_julia_flight: 'camera dips into the surface: step 0.14 at 1x over 360 s on Blue Plasma and Rose Metal (once each; the other two 0.099 at most)',
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
  scene('domain_colouring', 'Complex Domain Colouring', 'Math', 'domain-colouring', 'light', 'shader', () => import('./vendor/psychedelia/effects/domain-colouring.js')),
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
  scene('difs_tunnel_flight', 'DIFS Tunnel Flight', 'Fractals', 'difs-tunnel-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/difs-tunnel-flight.js')),
  scene('mandelbox_flight', 'Mandelbox Flight', 'Fractals', 'mandelbox-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/mandelbox-flight.js')),
  scene('folded_box_variants_flight', 'Folded Box Variants Flight', 'Fractals', 'folded-box-variants-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/folded-box-variants-flight.js')),
  scene('quaternion_julia_flight', 'Quaternion Julia Flight', 'Fractals', 'quaternion-julia-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/quaternion-julia-flight.js')),
  scene('hypercomplex_slice_flight', 'Hypercomplex Slice Flight', 'Fractals', 'hypercomplex-slice-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/hypercomplex-slice-flight.js')),
  scene('schottky_inversion_flight', 'Schottky Inversion Flight', 'Fractals', 'schottky-inversion-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/schottky-inversion-flight.js')),
  // Borrowed code under CC BY-NC-SA 3.0 and code with no licence stated
  // (CREDITS.md; manifest.json `borrowed`).
  scene('apollonian_foam_flight', 'Apollonian Foam Flight', 'Fractals', 'apollonian-foam-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/apollonian-foam-flight.js')),
  scene('polyfold_flight', 'Polyfold Flight', 'Fractals', 'polyfold-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/polyfold-flight.js')),
  scene('fractal_flame_volume_flight', '3D Fractal Flame Volume Flight', 'Fractals', 'fractal-flame-volume-flight', 'heavy', 'motion', () => import('./vendor/psychedelia/effects/fractal-flame-volume-flight.js')),
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
].map((entry) => Object.freeze({
  ...entry,
  mood: TAGS[entry.id][0],
  hue: TAGS[entry.id][1],
  ...(SPEED_CAPS[entry.id] ? { maxSpeed: SPEED_CAPS[entry.id] } : {}),
  fxCalm: FX_CALM_SCENES.has(entry.id),
  fxNone: FX_NONE_SCENES.has(entry.id),
  links: entry.links ? Object.freeze(entry.links) : null,
  defaults: entry.defaults ? Object.freeze(entry.defaults) : null,
})));

/** The scenes offered: every ported scene but the held ones. */
export const SCENES = Object.freeze(ALL_SCENES.filter((entry) => !Object.hasOwn(HELD_SCENES, entry.id)));
/** The held scenes' entries (for the flash check and the tests; never offered). */
export const HELD_SCENE_ENTRIES = Object.freeze(ALL_SCENES.filter((entry) => Object.hasOwn(HELD_SCENES, entry.id)));

/** The scenes as the list shows them: by category, then by name. Previous
 *  and next follow this order. */
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
