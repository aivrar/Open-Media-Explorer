/**
 * The Visualizer behind the Tuner: the rules and numbers, without the DOM
 * (modes/tuner-background.js draws it). A setting, off by default; with
 * TUNER_BACKGROUND_RELEASED off the setting is not offered and nothing is
 * made.
 *
 * - One renderer in the whole app: the Visualizer tab and this background
 *   take the one slot in turn (visualizer-slot.js). Only one is ever
 *   mounted; the other is destroyed (its WebGL context with it) before the
 *   new one makes its own.
 * - The scene is drawn as the tab would draw it, through the same mount, so
 *   the flash limiter, step-down and processor budget all apply. What it may
 *   draw is narrowed by tunerBackgroundSettings: light scenes only (the
 *   shuffle's cost filter at 'light'; a scene of the user's in another cost
 *   class is drawn here as the app's default scene, Plasma, which is light,
 *   and the user's own choice is not changed), no overlays (so no Strobe),
 *   no post effects at all (stricter than calm effects only), Low quality
 *   and at most 30 frames a second, no panel, readout or developer strip.
 * - It is drawn only after the photosensitivity notice was accepted in the
 *   Visualizer tab, only while sound plays, and only while the Tuner is the
 *   tab shown; it stops TUNER_BACKGROUND_STOP_GRACE_MS after the sound stops
 *   (a change of station does not start it all again).
 * - Dimmed: the layer is shown at TUNER_BACKGROUND_OPACITY over the Tuner's
 *   own background. Designed for 4.5:1 (WCAG AA) for every text colour the
 *   Tuner uses, in every theme, with the picture at its worst (all white in a
 *   dark theme, all black in the light one). At 0.08 the faintest, --text-mute,
 *   keeps 4.6:1 (5.5:1 to 6.2:1 without the layer), --text-dim 6.5:1 and
 *   --text 13.4:1 or more.
 * - Its strength: the Tuner tab's stepper (0-100) is the layer's opacity in
 *   percent, so the default level, 8, is exactly the 0.08 above, and 100 is
 *   no dimming at all (the user's choice; the 4.5:1 above holds up to the
 *   default). 0 is the setting off, as its Settings switch: the switch and
 *   the level are two settings (tunerVisualizerBackground and
 *   tunerVisualizerLevel), so switching it off and on in Settings brings back
 *   the level it had; turned down to 0 on the Tuner it comes back at the
 *   default (tunerBackgroundLevelPatch), and up from 0 there starts at 1.
 *   Only crossing 0 starts or stops it; any other level only changes the
 *   layer's opacity. The flash limiter and the notice are the same at every
 *   level.
 *
 * Measured (tests/helpers/visualizer-flash-check.py --realtime, the test
 * machine's graphics card): five scenes, each drawn alone by the measuring
 * page at Low, 1003 x 531 (the Low picture in a 1920 x 1080 window), 30
 * frames a second in real time for 30 s; the whole browser's processor
 * time as a share of one core: the light scenes Voronoi 6.9% and Plasma
 * 7.7%; Aurora 9.5% and Mandelbrot 11.0% (medium) and Black Hole 7.6%
 * (heavy), which the background does not draw; 0.1 ms of the graphics card
 * a frame (0.2 ms at the 95th percentile). Those figures are the scene's
 * own drawing.
 */

import { DEFAULT_VISUALIZER_SCENE, VISUALIZER_FRAME_RATES, normalizeVisualizerScene } from './visualizer-settings.js';

export const TUNER_BACKGROUND_RELEASED = true;
export const TUNER_BACKGROUND_QUALITY = 'low';
export const TUNER_BACKGROUND_FPS_MAX = 30;
export const TUNER_BACKGROUND_OPACITY = 0.08;
export const TUNER_BACKGROUND_STOP_GRACE_MS = 3000;
/** The one cost class of scene drawn behind the Tuner (visualizer/scenes.js
 *  cost), and the shuffle's cost filter there. */
export const TUNER_BACKGROUND_COST = 'light';
/** Drawn instead of a scene of another cost class: the app's default scene
 *  (Plasma, light). */
export const TUNER_BACKGROUND_SCENE = DEFAULT_VISUALIZER_SCENE;
export const TUNER_BACKGROUND_TEXT = Object.freeze({
  label: 'Show the Visualizer behind the Tuner',
  description: 'While sound plays, the Visualizer is drawn faintly behind the Tuner (how strongly is set on the Tuner tab), without overlays or effects, once its notice about flashing has been accepted in the Visualizer tab.',
});

/** The level a new user (or one from before the level existed) gets:
 *  TUNER_BACKGROUND_OPACITY in percent, the look it always had. */
export const TUNER_BACKGROUND_DEFAULT_LEVEL = 8;
export const TUNER_BACKGROUND_LEVEL_MAX = 100;

/** The saved level: a whole number from 1 to 100 (0 is the switch off, so
 *  it is never the saved level); anything else is the default. */
export function normalizeTunerBackgroundLevel(value) {
  // Only a number, or a string of plain digits (true, [100] and the like are
  // not levels, though Number() would make them one).
  const plain = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
  if (!plain) return TUNER_BACKGROUND_DEFAULT_LEVEL;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return TUNER_BACKGROUND_DEFAULT_LEVEL;
  return Math.min(TUNER_BACKGROUND_LEVEL_MAX, n);
}

/** The layer's opacity for a level: the level in percent. */
export function tunerBackgroundOpacity(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return TUNER_BACKGROUND_OPACITY;
  return Math.max(0, Math.min(TUNER_BACKGROUND_LEVEL_MAX, n)) / 100;
}

/** The level the Tuner's stepper shows: 0 while the setting is off. */
export function tunerBackgroundShownLevel(settings = {}) {
  return settings.tunerVisualizerBackground === true
    ? normalizeTunerBackgroundLevel(settings.tunerVisualizerLevel)
    : 0;
}

/** The settings to save for the stepper set to `level`, or null for none:
 *  0 turns the setting off, as the Settings switch does; above 0 sets the
 *  level and, from off, turns the setting on. Turned down to 0 here, the
 *  last level on the way was 1, which would be all but invisible when the
 *  Settings switch turns it on again, so the default is kept instead (the
 *  Settings switch itself keeps whatever level was set). */
export function tunerBackgroundLevelPatch(settings = {}, level) {
  const n = Math.max(0, Math.min(TUNER_BACKGROUND_LEVEL_MAX, Math.round(Number(level)) || 0));
  if (n === tunerBackgroundShownLevel(settings)) return null;
  if (n === 0) return { tunerVisualizerBackground: false, tunerVisualizerLevel: TUNER_BACKGROUND_DEFAULT_LEVEL };
  return settings.tunerVisualizerBackground === true
    ? { tunerVisualizerLevel: n }
    : { tunerVisualizerBackground: true, tunerVisualizerLevel: n };
}

/** Whether the background should be drawn now (the Tuner showing aside). */
export function tunerBackgroundWanted(appState) {
  const settings = appState?.settings || {};
  return settings.tunerVisualizerBackground === true
    && settings.visualizerNoticeSeen === true
    && appState?.isPlaying === true;
}

/** The settings the background's mount sees: the user's own, narrowed.
 *  `sceneCost(id)`: a scene's cost class (the Visualizer's sceneCost, given
 *  once it is loaded); a scene not known to be light (or without it) is
 *  drawn as TUNER_BACKGROUND_SCENE. */
export function tunerBackgroundSettings(settings = {}, sceneCost = null) {
  const fps = Number(settings.visualizerFps);
  const capped = VISUALIZER_FRAME_RATES.filter((rate) => rate <= TUNER_BACKGROUND_FPS_MAX);
  const scene = normalizeVisualizerScene(settings.visualizerScene);
  const light = typeof sceneCost === 'function' && sceneCost(scene) === TUNER_BACKGROUND_COST;
  return {
    ...settings,
    visualizerScene: light ? scene : TUNER_BACKGROUND_SCENE,
    // Picked, so it is used as it is at every Processor use level.
    visualizerShuffleCost: TUNER_BACKGROUND_COST,
    visualizerShuffleCostPicked: true,
    visualizerQuality: TUNER_BACKGROUND_QUALITY,
    visualizerQualityPicked: false,
    visualizerFps: capped.includes(fps) ? fps : Math.max(...capped),
    visualizerOverlays: false,
    visualizerFx: false,
    visualizerPanelOpen: false,
    visualizerShowFps: false,
    visualizerDebug: false,
  };
}
